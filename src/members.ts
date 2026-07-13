import { getAccessToken } from "./auth.js";
import type { ResolvedLineWorksAccount } from "./types.js";

const LINEWORKS_API_BASE = "https://www.worksapis.com/v1.0";
const PAGE_COUNT = 100; // API max per page (default is 50)
// ponytail: cursor-loop safety cap = 20k members; raise if a real room exceeds it
const MAX_PAGES = 200;

/**
 * List the userIds of a LINE WORKS talk room (channel) the bot participates
 * in.
 *
 * Verified against developers.worksmobile.com/jp/docs/bot-channel-member-list:
 *   GET /bots/{botId}/channels/{channelId}/members?count=100[&cursor=…]
 *   scope: bot.message | bot | bot.read (base token scopes already cover this)
 *   response: { "members": ["<userId>", …],
 *               "responseMetaData": { "nextCursor": "…" } }
 *
 * Fails CLOSED: any HTTP error, unexpected shape, pagination overflow, or
 * thrown fetch/auth error returns `null` (with the reason logged) — never an
 * empty array a caller could mistake for a real zero-member roster. Partial
 * pages are a failure too. The bot's own id is excluded from the result.
 */
export async function getChannelMembers(args: {
  account: ResolvedLineWorksAccount;
  channelId: string;
  log?: { warn?: (msg: string) => void };
}): Promise<string[] | null> {
  const { account, channelId } = args;
  const warn = (reason: string) =>
    args.log?.warn?.(`LINE WORKS getChannelMembers(${channelId}) failed: ${reason}`);
  if (!channelId) {
    warn("empty channelId");
    return null;
  }

  try {
    const access = await getAccessToken(account);
    const base = `${LINEWORKS_API_BASE}/bots/${encodeURIComponent(account.botId)}/channels/${encodeURIComponent(channelId)}/members`;
    const members: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(base);
      url.searchParams.set("count", String(PAGE_COUNT));
      if (cursor) url.searchParams.set("cursor", cursor);

      const res = await fetch(url, {
        headers: { authorization: `${access.tokenType} ${access.token}` },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        warn(`${res.status} ${text.slice(0, 120)}`);
        return null;
      }

      const json = (await res.json()) as {
        members?: unknown;
        responseMetaData?: { nextCursor?: unknown };
      };
      if (!Array.isArray(json.members) || json.members.some((m) => typeof m !== "string")) {
        warn("unexpected response shape (members is not a string array)");
        return null;
      }
      members.push(...(json.members as string[]));

      const next = json.responseMetaData?.nextCursor;
      if (typeof next !== "string" || next === "") {
        return members.filter((id) => id !== account.botId);
      }
      cursor = next;
    }

    warn(`pagination exceeded ${MAX_PAGES} pages`);
    return null;
  } catch (err) {
    warn(err instanceof Error ? err.message : String(err));
    return null;
  }
}
