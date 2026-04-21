import type { IncomingMessage, ServerResponse } from "node:http";
import {
  beginWebhookRequestPipelineOrReject,
  createWebhookInFlightLimiter,
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk/webhook-ingress";
import type { LineWorksInboundMessage } from "./inbound-context.js";
import type { ResolvedLineWorksAccount } from "./types.js";
import {
  LINEWORKS_SIGNATURE_HEADER,
  parseInboundEvent,
  verifySignature,
} from "./webhook.js";

const PREAUTH_MAX_BODY_BYTES = 64 * 1024;
const PREAUTH_BODY_TIMEOUT_MS = 5_000;
const webhookInFlightLimiter = createWebhookInFlightLimiter();

export interface LineWorksWebhookHandlerDeps {
  account: ResolvedLineWorksAccount;
  deliver: (msg: LineWorksInboundMessage) => Promise<null>;
  log?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  bodyTimeoutMs?: number;
}

function respondJson(
  res: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function respondNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

async function readBody(
  req: IncomingMessage,
  timeoutMs: number,
): Promise<{ ok: true; body: string } | { ok: false; statusCode: number; error: string }> {
  try {
    const body = await readRequestBodyWithLimit(req, {
      maxBytes: PREAUTH_MAX_BODY_BYTES,
      timeoutMs,
    });
    return { ok: true, body };
  } catch (err) {
    if (isRequestBodyLimitError(err)) {
      return {
        ok: false,
        statusCode: err.statusCode,
        error: requestBodyErrorToText(err.code),
      };
    }
    return { ok: false, statusCode: 400, error: "Invalid request body" };
  }
}

function headerValue(header: string | string[] | undefined): string | undefined {
  if (!header) return undefined;
  return Array.isArray(header) ? header[0] : header;
}

/**
 * Did the incoming message @mention the bot?
 *
 *   1. Structured: check content.mentionees[] for an accountId equal to the
 *      bot's botId or serviceAccount. LINE WORKS populates this when the
 *      user picks the bot from the @-autocomplete selector.
 *   2. Handle match: if `botMentionHandle` is configured (e.g. "Racco"), any
 *      text containing "@Racco" (case-insensitive, word-bounded) counts.
 *   3. Fallback: when no handle is configured, accept any @-token — noisy
 *      but keeps the bot responsive in a bare config.
 */
function isMentioningBot(
  content: {
    type: string;
    text?: string;
    mentionees?: Array<{ accountId?: string }>;
  },
  account: ResolvedLineWorksAccount,
): boolean {
  if (content.type !== "text") return false;

  const mentionees = content.mentionees ?? [];
  for (const m of mentionees) {
    if (m.accountId && (m.accountId === account.botId || m.accountId === account.serviceAccount)) {
      return true;
    }
  }

  const text = content.text ?? "";
  if (account.botMentionHandle) {
    // Escape regex metas in the handle, then match `@<handle>` with a
    // word-boundary after to avoid "@Racconi" matching "Racco".
    const h = account.botMentionHandle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^\\w])@${h}(?![\\w])`, "i");
    return re.test(text);
  }

  return /(^|\s)@[^\s]/.test(text);
}

export function createLineWorksWebhookHandler(deps: LineWorksWebhookHandlerDeps) {
  const { account, deliver, log } = deps;
  const inFlightKey = `lineworks:${account.accountId}`;

  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      respondJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const requestLifecycle = beginWebhookRequestPipelineOrReject({
      req,
      res,
      inFlightLimiter: webhookInFlightLimiter,
      inFlightKey,
    });
    if (!requestLifecycle.ok) return;

    try {
      const bodyResult = await readBody(req, deps.bodyTimeoutMs ?? PREAUTH_BODY_TIMEOUT_MS);
      if (!bodyResult.ok) {
        log?.warn(`lineworks: failed to read body: ${bodyResult.error}`);
        respondJson(res, bodyResult.statusCode, { error: bodyResult.error });
        return;
      }

      const signature =
        headerValue(req.headers[LINEWORKS_SIGNATURE_HEADER]) ??
        headerValue(req.headers["x-works-signature"]);

      if (
        !verifySignature({
          rawBody: bodyResult.body,
          signatureHeader: signature,
          botSecret: account.botSecret,
        })
      ) {
        log?.warn(`lineworks: invalid signature from ${req.socket?.remoteAddress ?? "unknown"}`);
        respondJson(res, 401, { error: "Invalid signature" });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyResult.body);
      } catch {
        respondJson(res, 400, { error: "Invalid JSON body" });
        return;
      }

      const event = parseInboundEvent(parsed);
      // Debug: log every inbound event shape until the image subscription is confirmed working.
      try {
        const rawTop = (parsed ?? {}) as Record<string, unknown>;
        const rawContent = (rawTop.content ?? {}) as Record<string, unknown>;
        const rawType = typeof rawTop.type === "string" ? rawTop.type : "?";
        const rawCT = typeof rawContent.type === "string" ? rawContent.type : "?";
        const keys = Object.keys(rawContent).slice(0, 12).join(",");
        log?.info?.(
          `lineworks: inbound event type=${rawType} content.type=${rawCT} content.keys=[${keys}] parsedKind=${event?.kind ?? "none"} parsedContent=${event?.content?.type ?? "none"}`,
        );
      } catch {
        /* ignore */
      }
      if (!event) {
        respondNoContent(res);
        return;
      }

      if (event.kind !== "user-message" && event.kind !== "channel-message") {
        log?.info?.(`lineworks: ignoring event kind=${event.kind}`);
        respondNoContent(res);
        return;
      }

      // Accept text, image, file, sticker, location. Anything else acks silently.
      const content = event.content;
      if (!content) {
        respondNoContent(res);
        return;
      }

      // Group-chat mention gate: when groupRequireMention is enabled, skip
      // dispatch for group messages that don't @mention the bot. DMs always
      // dispatch regardless. Mention is detected via content.mentionees (the
      // bot's accountId appearing) OR by the agent's display name token in
      // the text body (best-effort).
      if (event.kind === "channel-message" && account.groupRequireMention) {
        const mentions = isMentioningBot(content, account);
        const textPreview =
          content.type === "text" ? (content.text ?? "").slice(0, 80) : `<${content.type}>`;
        log?.info?.(
          `lineworks: mention-gate channelId=${event.source.type === "channel" ? event.source.channelId.slice(0, 8) : "?"} handle=${account.botMentionHandle ?? "<unset>"} mentions=${mentions} text="${textPreview}"`,
        );
        if (!mentions) {
          log?.info?.(
            `lineworks: group message not mentioning bot — skipping (groupRequireMention=true)`,
          );
          respondNoContent(res);
          return;
        }
      }

      let body = "";
      let imageResourceId: string | undefined;
      let fileResourceId: string | undefined;
      let fileName: string | undefined;
      switch (content.type) {
        case "text":
          body = content.text;
          break;
        case "image":
          imageResourceId = content.resourceId;
          break;
        case "file":
          fileResourceId = content.resourceId;
          fileName = content.fileName;
          body = fileName ? `[file: ${fileName}]` : "[file]";
          break;
        case "sticker":
          body = `[sticker ${content.packageId}:${content.stickerId}]`;
          break;
        case "location":
          body = `[location${content.title ? ` ${content.title}` : ""} ${content.latitude},${content.longitude}]`;
          break;
        case "postback":
          body = `[postback] ${content.data}`;
          break;
        default:
          log?.info?.(`lineworks: ignoring unknown content type`);
          respondNoContent(res);
          return;
      }

      const from = event.source.type === "channel" ? (event.source.userId ?? "unknown") : event.source.userId;
      const conversationId =
        event.source.type === "channel" ? event.source.channelId : event.source.userId;

      const msg: LineWorksInboundMessage = {
        body,
        from,
        senderName: from,
        conversationId,
        chatType: event.source.type === "channel" ? "group" : "direct",
        accountId: account.accountId,
        commandAuthorized: true,
        ...(imageResourceId || fileResourceId
          ? { attachmentResourceIds: [imageResourceId ?? fileResourceId!] }
          : {}),
      } as LineWorksInboundMessage;

      respondNoContent(res);

      // Fire-and-forget delivery; errors are logged inside deliver.
      void deliver(msg).catch((err) => {
        log?.error?.(`lineworks: deliver failed: ${String(err)}`);
      });
    } finally {
      requestLifecycle.release();
    }
  };
}
