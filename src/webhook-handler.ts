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
      if (!event) {
        respondNoContent(res);
        return;
      }

      if (event.kind !== "user-message" && event.kind !== "channel-message") {
        log?.info?.(`lineworks: ignoring event kind=${event.kind}`);
        respondNoContent(res);
        return;
      }

      if (!event.content || event.content.type !== "text") {
        log?.info?.(`lineworks: ignoring non-text content type=${event.content?.type ?? "none"}`);
        respondNoContent(res);
        return;
      }

      const from = event.source.type === "channel" ? (event.source.userId ?? "unknown") : event.source.userId;
      const conversationId =
        event.source.type === "channel" ? event.source.channelId : event.source.userId;

      const msg: LineWorksInboundMessage = {
        body: event.content.text,
        from,
        senderName: from,
        conversationId,
        chatType: event.source.type === "channel" ? "group" : "direct",
        accountId: account.accountId,
        commandAuthorized: true,
      };

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
