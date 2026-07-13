import { getAccessToken } from "./auth.js";
import type { ResolvedLineWorksAccount } from "./types.js";

const LINEWORKS_API_BASE = "https://www.worksapis.com/v1.0";
const PAGE_COUNT = 100; // API max per page
// ponytail: cursor-loop safety cap; raise if a real domain exceeds it
const MAX_PAGES = 200;

export interface OrgDirectoryUser {
  userId: string;
  email?: string;
  displayName?: string;
}

export interface OrgDirectoryGroup {
  groupId: string;
  groupName?: string;
}

function displayNameFromUserName(raw: Record<string, unknown>): string | undefined {
  const userName = raw["userName"];
  const firstName =
    typeof userName === "object" && userName !== null
      ? (userName as Record<string, unknown>)["firstName"]
      : undefined;
  const lastName =
    typeof userName === "object" && userName !== null
      ? (userName as Record<string, unknown>)["lastName"]
      : undefined;
  if (typeof firstName === "string" && typeof lastName === "string") {
    return `${lastName}${firstName}`.trim() || `${firstName} ${lastName}`.trim();
  }
  if (typeof firstName === "string") return firstName;
  if (typeof lastName === "string") return lastName;
  return undefined;
}

/**
 * List every user in the LINE WORKS domain the bot's service account belongs
 * to.
 *
 * Verified against developers.worksmobile.com/jp/docs/user-list:
 *   GET /users?count=100[&cursor=…]
 *   scope: user | user.read | directory | directory.read (any one)
 *   response: { "users": [{ "userId", "email", "userName": { "firstName", "lastName" }, … }],
 *               "responseMetaData": { "nextCursor": "…" } }
 *
 * `user.read` is NOT in the token's BASE_SCOPES (src/auth.ts) — it must be
 * opted in via `channels.lineworks.extraScopes` and granted in the
 * Developer Console, or every install's token issuance would be at risk of
 * breaking. On 401/403 the warn log hints at that operator step.
 *
 * Fails CLOSED: any HTTP error, unexpected shape, pagination overflow, or
 * thrown fetch/auth error returns `null` — never an empty array a caller
 * could mistake for a real zero-user domain. Partial pages are a failure
 * too.
 */
export async function listUsers(args: {
  account: ResolvedLineWorksAccount;
  log?: { warn?: (msg: string) => void };
}): Promise<OrgDirectoryUser[] | null> {
  const { account } = args;
  const warn = (reason: string) =>
    args.log?.warn?.(`LINE WORKS listUsers failed: ${reason}`);

  try {
    const access = await getAccessToken(account);
    const base = `${LINEWORKS_API_BASE}/users`;
    const users: OrgDirectoryUser[] = [];
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
        if (res.status === 401 || res.status === 403) {
          warn(
            `${res.status} ${text.slice(0, 120)} — add user.read (or directory.read) to ` +
              "channels.lineworks.extraScopes and grant it in the Developer Console",
          );
        } else {
          warn(`${res.status} ${text.slice(0, 120)}`);
        }
        return null;
      }

      const json = (await res.json()) as {
        users?: unknown;
        responseMetaData?: { nextCursor?: unknown };
      };
      if (!Array.isArray(json.users)) {
        warn("unexpected response shape (users is not an array)");
        return null;
      }
      for (const entry of json.users) {
        if (typeof entry !== "object" || entry === null || typeof (entry as Record<string, unknown>)["userId"] !== "string") {
          warn("unexpected response shape (user entry missing userId)");
          return null;
        }
        const raw = entry as Record<string, unknown>;
        users.push({
          userId: raw["userId"] as string,
          email: typeof raw["email"] === "string" ? (raw["email"] as string) : undefined,
          displayName: displayNameFromUserName(raw),
        });
      }

      const next = json.responseMetaData?.nextCursor;
      if (typeof next !== "string" || next === "") {
        return users;
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

/**
 * List every group in the LINE WORKS domain the bot's service account
 * belongs to.
 *
 * Verified against developers.worksmobile.com/jp/docs/group-list:
 *   GET /groups?count=100[&cursor=…]
 *   scope: directory | directory.read | group | group.read (any one)
 *   response: { "groups": [{ "groupId", "groupName", … }],
 *               "responseMetaData": { "nextCursor": "…" } }
 *
 * `group.read` is NOT in the token's BASE_SCOPES (src/auth.ts) — same
 * extraScopes opt-in requirement as listUsers above. On 401/403 the warn
 * log hints at that operator step.
 *
 * Fails CLOSED: any HTTP error, unexpected shape, pagination overflow, or
 * thrown fetch/auth error returns `null` — never an empty array a caller
 * could mistake for a real zero-group domain. Partial pages are a failure
 * too.
 */
export async function listGroups(args: {
  account: ResolvedLineWorksAccount;
  log?: { warn?: (msg: string) => void };
}): Promise<OrgDirectoryGroup[] | null> {
  const { account } = args;
  const warn = (reason: string) =>
    args.log?.warn?.(`LINE WORKS listGroups failed: ${reason}`);

  try {
    const access = await getAccessToken(account);
    const base = `${LINEWORKS_API_BASE}/groups`;
    const groups: OrgDirectoryGroup[] = [];
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
        if (res.status === 401 || res.status === 403) {
          warn(
            `${res.status} ${text.slice(0, 120)} — add group.read (or directory.read) to ` +
              "channels.lineworks.extraScopes and grant it in the Developer Console",
          );
        } else {
          warn(`${res.status} ${text.slice(0, 120)}`);
        }
        return null;
      }

      const json = (await res.json()) as {
        groups?: unknown;
        responseMetaData?: { nextCursor?: unknown };
      };
      if (!Array.isArray(json.groups)) {
        warn("unexpected response shape (groups is not an array)");
        return null;
      }
      for (const entry of json.groups) {
        if (typeof entry !== "object" || entry === null || typeof (entry as Record<string, unknown>)["groupId"] !== "string") {
          warn("unexpected response shape (group entry missing groupId)");
          return null;
        }
        const raw = entry as Record<string, unknown>;
        groups.push({
          groupId: raw["groupId"] as string,
          groupName: typeof raw["groupName"] === "string" ? (raw["groupName"] as string) : undefined,
        });
      }

      const next = json.responseMetaData?.nextCursor;
      if (typeof next !== "string" || next === "") {
        return groups;
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
