import { getAccessToken } from "./auth.js";
import type {
  LineWorksOutboundMessage,
  LineWorksTarget,
  ResolvedLineWorksAccount,
} from "./types.js";

const LINEWORKS_API_BASE = "https://www.worksapis.com/v1.0";
const TEXT_CHUNK_LIMIT = 2000;

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

export async function sendText(args: {
  account: ResolvedLineWorksAccount;
  target: LineWorksTarget;
  text: string;
}): Promise<void> {
  const chunks = splitText(args.text, TEXT_CHUNK_LIMIT);
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

function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(cursor + limit, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > cursor + limit * 0.5) end = nl;
    }
    chunks.push(text.slice(cursor, end));
    cursor = end;
  }
  return chunks;
}
