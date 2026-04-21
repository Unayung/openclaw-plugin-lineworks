import {
  downloadLineWorksAttachment,
  isHttpUrl,
  uploadLineWorksAttachment,
} from "./attachments.js";
import { chunkText, LINEWORKS_TEXT_CHUNK_LIMIT } from "./chunk-text.js";
import { extractDirectives } from "./directives.js";
import {
  buildLineWorksInboundContext,
  type LineWorksInboundMedia,
  type LineWorksInboundMessage,
} from "./inbound-context.js";
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
 * For audio, a duration is required — default 10s if unknown.
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
      return { type: "audio", fileId: uploaded.fileId, duration: DEFAULT_AUDIO_DURATION_MS };
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
      return { type: "audio", originalContentUrl: url, duration: DEFAULT_AUDIO_DURATION_MS };
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

  const msgWithMedia: LineWorksInboundMessage = {
    ...params.msg,
    media: media.length ? media : undefined,
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
          residualText,
          parseErrors,
        } = extractDirectives(rawText);
        for (const err of parseErrors) params.log?.warn?.(`LINE WORKS: ${err}`);
        const text = residualText;

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
          locations.length === 0
        ) {
          params.log?.info?.(
            `LINE WORKS: deliver called with empty payload for ${params.msg.from} (skipping send)`,
          );
          return;
        }

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
              const kind = mediaKindForExt(
                extOf(new URL(mediaUrl).pathname || mediaUrl),
              );
              const content = buildContentFromHttpsUrl(kind, mediaUrl);
              if (!content) {
                throw new Error(
                  `LINE WORKS cannot send ${kind} as URL without required metadata (use channelData or upload a local file)`,
                );
              }
              outbound.push(content);
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

        if (text) outbound.push({ type: "text", text });
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
