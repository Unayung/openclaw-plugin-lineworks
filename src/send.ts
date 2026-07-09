import { getAccessToken } from "./auth.js";
import { chunkText, LINEWORKS_TEXT_CHUNK_LIMIT } from "./chunk-text.js";
import { extractDirectives } from "./directives.js";
import type {
  LineWorksOutboundMessage,
  LineWorksQuickReply,
  LineWorksTarget,
  ResolvedLineWorksAccount,
} from "./types.js";

const LINEWORKS_API_BASE = "https://www.worksapis.com/v1.0";

/**
 * Turn agent reply text into the ordered LINE WORKS messages to send, processing
 * inline directives so they render on the gateway outbound path too — not just
 * the inbound reply dispatcher. Strips every `[[…]]` directive so none leak as
 * raw text; renders `[[flex: …]]` and `[[location: …]]` as their own messages;
 * and attaches a `[[quick_replies: …]]` quickReply to the LAST message. Text is
 * split on the 2000-char chunk boundary. Order matches the inbound dispatcher:
 * text → flex → location, quickReply on the last.
 *
 * Used by the gateway outbound path (message-tool sends, e.g. group replies in
 * `message_tool` mode). Without it that path emitted raw directive text because
 * only the inbound reply dispatcher processed directives. Pure (no network) so
 * it is unit-testable.
 *
 * Not handled here: `[[mail_send: …]]` — sending mail needs the inbound sender's
 * email, which this outbound context does not carry, so mail directives are
 * stripped (not sent) on this path. They remain fully supported inbound.
 *
 * `opts.groupMentionHandle` — in a group/channel, a bot only sees messages that
 * @mention it (groupRequireMention), but tapping a quick-reply chip sends the
 * plain label with no mention, so the tap never reaches the bot. Passing the
 * bot's mention handle rewrites each chip's SENT text to `@<handle> <label>`
 * (the displayed label is unchanged) so taps pass the mention gate. Omit in DMs.
 */
export function buildTextOutboundMessages(
  text: string,
  opts: { groupMentionHandle?: string } = {},
): LineWorksOutboundMessage[] {
  const { residualText, flex, locations, quickReply: rawQuickReply } = extractDirectives(text);
  const quickReply =
    rawQuickReply && opts.groupMentionHandle
      ? mentionizeQuickReply(rawQuickReply, opts.groupMentionHandle)
      : rawQuickReply;
  const textMessages: LineWorksOutboundMessage[] = chunkText(residualText, LINEWORKS_TEXT_CHUNK_LIMIT)
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => ({ type: "text", text: chunk }));
  const messages: LineWorksOutboundMessage[] = [...textMessages, ...flex, ...locations];
  if (messages.length === 0) {
    // Nothing visible after stripping; still carry chips on a minimal message.
    return quickReply ? [{ type: "text", text: residualText || " ", quickReply }] : [];
  }
  if (quickReply) {
    // Attach to the last message. `content.quickReply` is valid for any message
    // type; only the text message declares the field in our types, so cast.
    const last = messages[messages.length - 1];
    if (last) (last as { quickReply?: LineWorksQuickReply }).quickReply = quickReply;
  }
  return messages;
}

/**
 * Rewrite each `message`-type quick-reply action's SENT text to `@<handle> <text>`
 * so tapping the chip in a group @mentions the bot and passes the mention gate.
 * The displayed `label` is left untouched; `uri`/`postback` actions send no text
 * to the bot, so they are left as-is. Idempotent: text already starting with the
 * mention is not prefixed again.
 */
function mentionizeQuickReply(qr: LineWorksQuickReply, handle: string): LineWorksQuickReply {
  const prefix = `@${handle}`;
  return {
    items: qr.items.map((item) => {
      if (item.action.type !== "message") return item;
      const text = item.action.text;
      if (text.startsWith(prefix)) return item;
      return { ...item, action: { ...item.action, text: `${prefix} ${text}` } };
    }),
  };
}

export async function sendMessage(args: {
  account: ResolvedLineWorksAccount;
  target: LineWorksTarget;
  message: LineWorksOutboundMessage;
}): Promise<void> {
  const { account, target, message } = args;
  const access = await getAccessToken(account);
  const url = buildSendUrl(account, target);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `${access.tokenType} ${access.token}`,
    },
    body: JSON.stringify({ content: message }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LINE WORKS send failed: ${res.status} ${text}`);
  }
}

// `sticker:"<packageId>:<stickerId>"` (quotes optional) — a shorthand for
// sending a native LINE WORKS sticker through the plain-text path. Used by the
// `thinkingAck` config so an ack can be a sticker instead of text.
const STICKER_SHORTHAND_RE = /^sticker:"?(\d+):(\d+)"?$/;

export async function sendText(args: {
  account: ResolvedLineWorksAccount;
  target: LineWorksTarget;
  text: string;
}): Promise<void> {
  const stickerMatch = args.text.trim().match(STICKER_SHORTHAND_RE);
  if (stickerMatch) {
    const [, packageId, stickerId] = stickerMatch;
    if (packageId && stickerId) {
      await sendMessage({
        account: args.account,
        target: args.target,
        message: { type: "sticker", packageId, stickerId },
      });
      return;
    }
  }

  const chunks = chunkText(args.text, LINEWORKS_TEXT_CHUNK_LIMIT);
  for (const chunk of chunks) {
    await sendMessage({
      account: args.account,
      target: args.target,
      message: { type: "text", text: chunk },
    });
  }
}

function buildSendUrl(account: ResolvedLineWorksAccount, target: LineWorksTarget): string {
  const botId = encodeURIComponent(account.botId);
  if (target.type === "user") {
    return `${LINEWORKS_API_BASE}/bots/${botId}/users/${encodeURIComponent(target.userId)}/messages`;
  }
  return `${LINEWORKS_API_BASE}/bots/${botId}/channels/${encodeURIComponent(target.channelId)}/messages`;
}

