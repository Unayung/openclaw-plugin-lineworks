import {
  downloadLineWorksAttachment,
  isHttpUrl,
  uploadLineWorksAttachment,
} from "./attachments.js";
import {
  buildLineWorksInboundContext,
  type LineWorksInboundMedia,
  type LineWorksInboundMessage,
} from "./inbound-context.js";
import { getLineWorksRuntime } from "./runtime.js";
import { sendMessage, sendText } from "./send.js";
import { buildLineWorksInboundSessionKey } from "./session-key.js";
import type { ResolvedLineWorksAccount } from "./types.js";

const CHANNEL_ID = "lineworks";

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

  await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: msgCtx,
    cfg: currentCfg,
    dispatcherOptions: {
      deliver: async (
        payload: {
          text?: string;
          body?: string;
          mediaUrl?: string;
          mediaUrls?: string[];
        },
      ) => {
        const text = payload.text ?? payload.body ?? "";
        const mediaUrls: string[] = [
          ...(payload.mediaUrls ?? []),
          ...(payload.mediaUrl ? [payload.mediaUrl] : []),
        ].filter((u) => !!u && u.trim().length > 0);

        if (!text && mediaUrls.length === 0) {
          params.log?.info?.(
            `LINE WORKS: deliver called with empty payload for ${params.msg.from} (skipping send)`,
          );
          return;
        }

        const targetDesc =
          replyTarget.type === "channel"
            ? `channel:${replyTarget.channelId}`
            : `user:${replyTarget.userId}`;

        // Send media first (if any), then any text caption — LINE WORKS
        // shows them as separate messages in the same conversation.
        for (const mediaUrl of mediaUrls) {
          try {
            if (isHttpUrl(mediaUrl)) {
              // Public URL path — LINE WORKS fetches it directly. Must be HTTPS.
              if (!mediaUrl.startsWith("https://")) {
                throw new Error(
                  `LINE WORKS requires https:// URLs for media (got: ${mediaUrl.slice(0, 80)})`,
                );
              }
              await sendMessage({
                account: params.account,
                target: replyTarget,
                message: {
                  type: "image",
                  previewImageUrl: mediaUrl,
                  originalContentUrl: mediaUrl,
                },
              });
            } else {
              // Local file path — upload to LINE WORKS, then reference by fileId.
              const localPath = mediaUrl.replace(/^file:\/\//, "");
              const uploaded = await uploadLineWorksAttachment({
                account: params.account,
                filePath: localPath,
              });
              await sendMessage({
                account: params.account,
                target: replyTarget,
                message: { type: "image", fileId: uploaded.fileId },
              });
              params.log?.info?.(
                `LINE WORKS: uploaded local file ${uploaded.fileName} -> fileId=${uploaded.fileId}`,
              );
            }
            params.log?.info?.(
              `LINE WORKS: media delivered to ${targetDesc}: ${mediaUrl.slice(0, 120)}`,
            );
          } catch (err) {
            params.log?.error?.(
              `LINE WORKS: failed to deliver media to ${targetDesc} (${mediaUrl}): ${String(err)}`,
            );
          }
        }

        if (text) {
          const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
          try {
            await sendText({ account: params.account, target: replyTarget, text });
            params.log?.info?.(
              `LINE WORKS: reply delivered to ${targetDesc} (${text.length} chars): ${preview}`,
            );
          } catch (err) {
            params.log?.error?.(
              `LINE WORKS: failed to deliver reply to ${targetDesc}: ${String(err)}`,
            );
          }
        }
      },
      onReplyStart: () => {
        params.log?.info?.(`Agent reply started for ${params.msg.from}`);
      },
    },
  });

  return null;
}
