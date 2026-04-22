import {
  downloadHttpsToTempFile,
  downloadLineWorksAttachment,
  isHttpUrl,
  mediaKindForContentType,
  uploadLineWorksAttachment,
} from "./attachments.js";
import { chunkText, LINEWORKS_TEXT_CHUNK_LIMIT } from "./chunk-text.js";
import { getUserProfile } from "./directory.js";
import { extractDirectives } from "./directives.js";
import {
  buildLineWorksInboundContext,
  type LineWorksInboundMedia,
  type LineWorksInboundMessage,
} from "./inbound-context.js";
import { sendMail } from "./mail.js";
import { getLineWorksRuntime } from "./runtime.js";
import { sendMessage, sendText } from "./send.js";
import { buildLineWorksInboundSessionKey } from "./session-key.js";
import type {
  LineWorksOutboundMessage,
  LineWorksQuickReply,
  ResolvedLineWorksAccount,
} from "./types.js";

const CHANNEL_ID = "lineworks";
const DEFAULT_ACK_DELAY_MS = 5000;
const DEFAULT_ACK_TEXT = "⋯";
const DEFAULT_AUDIO_DURATION_MS = 10_000;

type LineWorksChannelLog = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

type LineWorksTarget =
  | { type: "user"; userId: string }
  | { type: "channel"; channelId: string };

function buildReplyTarget(msg: LineWorksInboundMessage): LineWorksTarget {
  return msg.chatType === "group"
    ? { type: "channel", channelId: msg.conversationId }
    : { type: "user", userId: msg.from };
}

function targetDescription(t: LineWorksTarget): string {
  return t.type === "channel" ? `channel:${t.channelId}` : `user:${t.userId}`;
}

function extOf(p: string): string {
  return p.toLowerCase().split(".").pop() ?? "";
}


type MediaKind = "image" | "video" | "audio" | "file";
function mediaKindForExt(ext: string): MediaKind {
  if (["jpg", "jpeg", "png", "gif", "webp", "heic"].includes(ext)) return "image";
  if (["mp4", "mov", "m4v", "avi", "webm"].includes(ext)) return "video";
  if (["mp3", "m4a", "wav", "aac", "ogg", "oga"].includes(ext)) return "audio";
  return "file";
}

/**
 * Compose a LINE WORKS content payload from a resolved local-file upload,
 * branching by media kind. For video, LINE WORKS requires `previewImageUrl`
 * when using URL form; the fileId form sends without a preview thumbnail.
 * For audio, the official spec (bot-send-audio) only accepts `type` + one
 * of `originalContentUrl`/`fileId` — NO `duration`. Sending a bonus
 * `duration` field triggers a 400 INVALID_PARAMETER with a misleading
 * "content.fileId content is invalid" message.
 */
function buildContentFromUpload(
  kind: MediaKind,
  uploaded: { fileId: string; fileName: string },
): LineWorksOutboundMessage {
  switch (kind) {
    case "image":
      return { type: "image", fileId: uploaded.fileId };
    case "video":
      return { type: "video", fileId: uploaded.fileId };
    case "audio":
      return { type: "audio", fileId: uploaded.fileId };
    default:
      return { type: "file", fileId: uploaded.fileId, fileName: uploaded.fileName };
  }
}

function buildContentFromHttpsUrl(
  kind: MediaKind,
  url: string,
): LineWorksOutboundMessage | undefined {
  switch (kind) {
    case "image":
      return { type: "image", previewImageUrl: url, originalContentUrl: url };
    case "video":
      // previewImageUrl missing on a bare URL — the agent must supply one via
      // channelData if it cares about the thumbnail. Without one, LINE WORKS
      // rejects the video. Return undefined so the caller can log.
      return undefined;
    case "audio":
      return { type: "audio", originalContentUrl: url };
    default:
      return undefined;
  }
}

/**
 * Apply a quickReply to the last outbound message in a sequence. Mutates the
 * array in place. `quickReply` is sent inside `content.quickReply` per
 * LINE WORKS bot API.
 */
function attachQuickReplyToLast(
  messages: LineWorksOutboundMessage[],
  quickReply: LineWorksQuickReply,
): void {
  if (messages.length === 0) return;
  const last = messages[messages.length - 1]!;
  (last as unknown as { quickReply?: LineWorksQuickReply }).quickReply = quickReply;
}

export async function dispatchLineWorksInboundTurn(params: {
  account: ResolvedLineWorksAccount;
  msg: LineWorksInboundMessage;
  log?: LineWorksChannelLog;
}): Promise<null> {
  const rt = getLineWorksRuntime();
  const currentCfg = rt.config.loadConfig();
  const route = rt.channel.routing.resolveAgentRoute({
    cfg: currentCfg,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    peer: {
      kind: params.msg.chatType === "group" ? "group" : "direct",
      id: params.msg.conversationId,
    },
  });

  const sessionKey = buildLineWorksInboundSessionKey({
    agentId: route.agentId,
    accountId: params.account.accountId,
    sourceKind: params.msg.chatType === "group" ? "channel" : "user",
    sourceId: params.msg.conversationId,
    identityLinks: currentCfg.session?.identityLinks,
  });

  // Download any attachments referenced by the inbound event so the agent
  // sees the media directly in its context.
  const media: LineWorksInboundMedia[] = [...(params.msg.media ?? [])];
  for (const resourceId of params.msg.attachmentResourceIds ?? []) {
    try {
      const dl = await downloadLineWorksAttachment({ account: params.account, resourceId });
      media.push({ path: dl.path, contentType: dl.contentType });
      params.log?.info?.(
        `LINE WORKS: downloaded attachment ${resourceId} (${dl.size} bytes, ${dl.contentType})`,
      );
    } catch (err) {
      params.log?.error?.(
        `LINE WORKS: failed to download attachment ${resourceId}: ${String(err)}`,
      );
    }
  }

  // Best-effort directory lookup to attach email/name/department to context.
  // Failures (missing scope, 401/403, network) are logged and treated as null
  // so the agent still gets the message — just without the enriched profile.
  let senderEmail: string | undefined;
  let senderFullName: string | undefined;
  let senderDepartment: string | undefined;
  let senderTitle: string | undefined;
  if (params.account.senderProfileEnrichment && params.msg.from) {
    try {
      const profile = await getUserProfile({
        account: params.account,
        userId: params.msg.from,
        log: params.log,
      });
      if (profile) {
        senderEmail = profile.email;
        senderFullName = profile.displayName || profile.userName;
        senderDepartment = profile.department;
        senderTitle = profile.position;
        params.log?.info?.(
          `LINE WORKS: resolved sender ${params.msg.from} → ${profile.email ?? "?"} (${senderFullName ?? "?"})`,
        );
      }
    } catch (err) {
      params.log?.warn?.(
        `LINE WORKS: directory lookup failed for ${params.msg.from}: ${String(err)}`,
      );
    }
  }

  // Context enrichment removed in v0.5.0: openclaw's prompt builder drops
  // custom ctx keys, so the model never saw these anyway. The supported
  // path is for the agent to read the OAuth token from disk and call
  // LINE WORKS APIs directly via `exec` + `curl`. We still resolve the
  // sender email above (it's used for the `resolved sender` log line,
  // which helps operators follow what's happening).
  const msgWithMedia: LineWorksInboundMessage = {
    ...params.msg,
    media: media.length ? media : undefined,
    senderEmail,
    senderFullName,
    senderDepartment,
    senderTitle,
  };

  const msgCtx = buildLineWorksInboundContext({
    finalizeInboundContext: rt.channel.reply.finalizeInboundContext,
    account: params.account,
    msg: msgWithMedia,
    sessionKey,
  });

  const replyTarget = buildReplyTarget(params.msg);
  const targetDesc = targetDescription(replyTarget);

  // Delayed thinking-ack: if no reply payload arrives within N ms, send a
  // short "still working" message so the user doesn't stare at silence.
  // Defaults: 5s delay, "⋯". delayMs=0 disables.
  const ackCfg = params.account.config.thinkingAck ?? {};
  const ackDelayMs = ackCfg.delayMs ?? DEFAULT_ACK_DELAY_MS;
  const ackText = ackCfg.text ?? DEFAULT_ACK_TEXT;
  let firstReplyDelivered = false;
  let ackSent = false;
  let ackTimer: NodeJS.Timeout | undefined;
  if (ackDelayMs > 0 && ackText) {
    ackTimer = setTimeout(() => {
      if (firstReplyDelivered) return;
      ackSent = true;
      params.log?.info?.(
        `LINE WORKS: thinking-ack fired for ${targetDesc} after ${ackDelayMs}ms (text: ${ackText})`,
      );
      sendText({ account: params.account, target: replyTarget, text: ackText }).catch((err) => {
        params.log?.warn?.(`LINE WORKS: thinking-ack send failed: ${String(err)}`);
      });
    }, ackDelayMs);
  }

  await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: msgCtx,
    cfg: currentCfg,
    dispatcherOptions: {
      deliver: async (payload: {
        text?: string;
        body?: string;
        mediaUrl?: string;
        mediaUrls?: string[];
        channelData?: Record<string, unknown>;
      }) => {
        if (!firstReplyDelivered) {
          firstReplyDelivered = true;
          if (ackTimer) clearTimeout(ackTimer);
        }

        const rawText = payload.text ?? payload.body ?? "";
        const rawMediaUrls: string[] = [
          ...(payload.mediaUrls ?? []),
          ...(payload.mediaUrl ? [payload.mediaUrl] : []),
        ].filter((u) => !!u && u.trim().length > 0);

        const {
          flex: flexFromText,
          locations: locationsFromText,
          quickReply: quickReplyFromText,
          mailSends,
          residualText,
          parseErrors,
        } = extractDirectives(rawText);
        for (const err of parseErrors) params.log?.warn?.(`LINE WORKS: ${err}`);
        const text = residualText;

        // Execute mail_send directives before composing the outbound reply.
        // Each result becomes a short "✉︎ sent to <recipients>" / "✉︎ failed"
        // note appended after the agent's text so the user sees what landed.
        const mailResultNotes: string[] = [];
        for (const mail of mailSends) {
          const fromMailbox = msgWithMedia.senderEmail;
          if (!fromMailbox) {
            mailResultNotes.push(
              `✉︎ mail skipped (need sender email; user.profile.read scope not granted?)`,
            );
            params.log?.warn?.(
              `LINE WORKS: mail_send requested but sender email unknown (userId=${params.msg.from})`,
            );
            continue;
          }
          try {
            await sendMail({
              account: params.account,
              from: fromMailbox,
              to: mail.to,
              cc: mail.cc,
              bcc: mail.bcc,
              subject: mail.subject,
              body: mail.body,
            });
            mailResultNotes.push(`✉︎ sent to ${mail.to.join(", ")}`);
            params.log?.info?.(
              `LINE WORKS: mail sent from=${fromMailbox} to=${mail.to.join(",")} subject="${mail.subject.slice(0, 60)}"`,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            mailResultNotes.push(`✉︎ mail send failed: ${msg.slice(0, 100)}`);
            params.log?.error?.(`LINE WORKS: mail send failed: ${msg}`);
          }
        }

        const lw = (payload.channelData?.lineworks ?? {}) as {
          flexMessage?: { altText: string; contents: Record<string, unknown> };
          flexMessages?: Array<{ altText: string; contents: Record<string, unknown> }>;
          quickReply?: LineWorksQuickReply;
          location?: {
            title: string;
            address: string;
            latitude: number;
            longitude: number;
          };
        };
        const flex = [...flexFromText];
        if (lw.flexMessage) flex.push({ type: "flex", ...lw.flexMessage });
        for (const fm of lw.flexMessages ?? []) flex.push({ type: "flex", ...fm });
        const locations = [...locationsFromText];
        if (lw.location) locations.push({ type: "location", ...lw.location });
        const quickReply = quickReplyFromText ?? lw.quickReply;

        if (
          !text &&
          rawMediaUrls.length === 0 &&
          flex.length === 0 &&
          locations.length === 0 &&
          mailResultNotes.length === 0
        ) {
          params.log?.info?.(
            `LINE WORKS: deliver called with empty payload for ${params.msg.from} (skipping send)`,
          );
          return;
        }

        // Fold mail result notes into the text the user sees, either appended
        // to the agent's reply (with a blank line before) or as their own
        // message when the agent said nothing.
        const textWithMailNotes =
          mailResultNotes.length > 0
            ? (text ? `${text}\n\n${mailResultNotes.join("\n")}` : mailResultNotes.join("\n"))
            : text;

        // Build an ordered sequence of LINE WORKS messages: media → text →
        // flex → location. The last one gets the quickReply attached.
        const outbound: LineWorksOutboundMessage[] = [];

        for (const mediaUrl of rawMediaUrls) {
          try {
            if (isHttpUrl(mediaUrl)) {
              if (!mediaUrl.startsWith("https://")) {
                throw new Error(
                  `LINE WORKS requires https:// URLs (got: ${mediaUrl.slice(0, 80)})`,
                );
              }
              const urlExtKind = mediaKindForExt(extOf(new URL(mediaUrl).pathname || mediaUrl));
              // Images with a recognized extension can be sent by URL direct
              // (LINE WORKS fetches it). Everything else — video, audio, file,
              // or an extension-less URL — gets downloaded + uploaded. The
              // message kind is re-derived from the actual Content-Type when
              // the URL extension was "file" / ambiguous.
              if (urlExtKind === "image") {
                const content = buildContentFromHttpsUrl(urlExtKind, mediaUrl);
                if (content) {
                  outbound.push(content);
                  break;
                }
              }
              const dl = await downloadHttpsToTempFile(mediaUrl);
              const kind =
                urlExtKind === "file" ? mediaKindForContentType(dl.contentType) : urlExtKind;
              const uploaded = await uploadLineWorksAttachment({
                account: params.account,
                filePath: dl.path,
                fileName: dl.fileName,
              });
              outbound.push(buildContentFromUpload(kind, uploaded));
              params.log?.info?.(
                `LINE WORKS: fetched ${mediaUrl} (${dl.size}B, ${dl.contentType}) → uploaded as ${kind} fileId=${uploaded.fileId}`,
              );
            } else {
              const localPath = mediaUrl.replace(/^file:\/\//, "");
              const kind = mediaKindForExt(extOf(localPath));
              const uploaded = await uploadLineWorksAttachment({
                account: params.account,
                filePath: localPath,
              });
              outbound.push(buildContentFromUpload(kind, uploaded));
              params.log?.info?.(
                `LINE WORKS: uploaded ${uploaded.fileName} (${kind}) -> fileId=${uploaded.fileId}`,
              );
            }
          } catch (err) {
            params.log?.error?.(
              `LINE WORKS: failed to prepare media (${mediaUrl}): ${String(err)}`,
            );
          }
        }

        if (textWithMailNotes) outbound.push({ type: "text", text: textWithMailNotes });
        for (const fl of flex) outbound.push(fl);
        for (const loc of locations) outbound.push(loc);

        if (quickReply) attachQuickReplyToLast(outbound, quickReply);

        for (const message of outbound) {
          const label =
            message.type === "text"
              ? `text(${(message as { text: string }).text.length}c)`
              : message.type;
          try {
            if (message.type === "text") {
              // Route through sendText so the 2000-char chunker splits long
              // replies on newline boundaries. LINE WORKS rejects content.text
              // over ~2000 chars (EXCEEDED_LENGTH_LIMIT_OF_PARAM).
              // NOTE: if this message has a quickReply attached, only the
              // final chunk carries it — we send preceding chunks as-is and
              // fold quickReply into the last via a single final sendMessage.
              const qr = (message as { quickReply?: unknown }).quickReply;
              if (qr) {
                const text = (message as { text: string }).text;
                if (text.length <= LINEWORKS_TEXT_CHUNK_LIMIT) {
                  await sendMessage({ account: params.account, target: replyTarget, message });
                } else {
                  const chunks = chunkText(text, LINEWORKS_TEXT_CHUNK_LIMIT);
                  for (let i = 0; i < chunks.length - 1; i++) {
                    await sendText({
                      account: params.account,
                      target: replyTarget,
                      text: chunks[i]!,
                    });
                  }
                  const lastChunk = chunks[chunks.length - 1]!;
                  await sendMessage({
                    account: params.account,
                    target: replyTarget,
                    message: { type: "text", text: lastChunk, quickReply: qr } as never,
                  });
                }
              } else {
                await sendText({
                  account: params.account,
                  target: replyTarget,
                  text: (message as { text: string }).text,
                });
              }
            } else {
              await sendMessage({ account: params.account, target: replyTarget, message });
            }
            params.log?.info?.(`LINE WORKS: ${label} delivered to ${targetDesc}`);
          } catch (err) {
            params.log?.error?.(
              `LINE WORKS: failed to deliver ${label} to ${targetDesc}: ${String(err)}`,
            );
          }
        }

        if (ackSent && outbound.length > 0) {
          params.log?.info?.(
            `LINE WORKS: real reply delivered after thinking-ack was sent (user saw both)`,
          );
        }
      },
      onReplyStart: () => {
        params.log?.info?.(`Agent reply started for ${params.msg.from}`);
      },
    },
  });

  // Defensive: if the dispatcher exits without ever calling deliver, make
  // sure we don't leak the ack timer.
  if (ackTimer && !firstReplyDelivered) {
    clearTimeout(ackTimer);
  }

  return null;
}
