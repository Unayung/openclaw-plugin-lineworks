import { getAccessToken } from "./auth.js";
import type { ResolvedLineWorksAccount } from "./types.js";

const LINEWORKS_API_BASE = "https://www.worksapis.com/v1.0";
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/**
 * Subset of the LINE WORKS user profile we surface to the agent. The API
 * returns much more (avatar, phone, telephone, birthday, externalKey, …);
 * only the fields that are useful as agent context are extracted here.
 */
export interface LineWorksUserProfile {
  userId: string;
  email?: string;
  userName?: string;
  displayName?: string;
  nickName?: string;
  department?: string;
  position?: string;
}

type CacheEntry = {
  profile: LineWorksUserProfile | null;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();

function cacheKey(account: ResolvedLineWorksAccount, userId: string): string {
  return `${account.accountId}:${userId}`;
}

function extractProfile(userId: string, raw: Record<string, unknown>): LineWorksUserProfile {
  const userName = raw["userName"];
  const firstName =
    typeof userName === "object" && userName !== null
      ? (userName as Record<string, unknown>)["firstName"]
      : undefined;
  const lastName =
    typeof userName === "object" && userName !== null
      ? (userName as Record<string, unknown>)["lastName"]
      : undefined;
  const fullName =
    typeof firstName === "string" && typeof lastName === "string"
      ? `${lastName}${firstName}`.trim() || `${firstName} ${lastName}`.trim()
      : typeof firstName === "string"
        ? firstName
        : typeof lastName === "string"
          ? lastName
          : undefined;

  const orgs = raw["organizations"];
  let department: string | undefined;
  let position: string | undefined;
  if (Array.isArray(orgs) && orgs.length > 0) {
    const first = orgs[0] as Record<string, unknown>;
    const deptObj = first?.["orgUnits"];
    if (Array.isArray(deptObj) && deptObj.length > 0) {
      const u = deptObj[0] as Record<string, unknown>;
      if (typeof u?.["orgUnitName"] === "string") department = u["orgUnitName"] as string;
    }
    if (typeof first?.["primary"] === "boolean" && typeof first?.["name"] === "string" && !department) {
      department = first["name"] as string;
    }
    if (typeof first?.["position"] === "string") position = first["position"] as string;
  }

  return {
    userId,
    email: typeof raw["email"] === "string" ? (raw["email"] as string) : undefined,
    userName: fullName,
    displayName: typeof raw["displayName"] === "string" ? (raw["displayName"] as string) : fullName,
    nickName: typeof raw["nickName"] === "string" ? (raw["nickName"] as string) : undefined,
    department,
    position,
  };
}

/**
 * Resolve a LINE WORKS userId (the UUID that shows up in webhook
 * `source.userId`) to a profile including email, display name, department,
 * and position.
 *
 * Requires the bot app to have `user.profile.read` (or `user.email.read` for
 * email-only). Missing scope → 401/403 → we log-and-null so the caller can
 * degrade gracefully (agent just won't see the profile fields).
 *
 * Results are cached per (accountId, userId) with a 1-hour TTL.
 */
export async function getUserProfile(args: {
  account: ResolvedLineWorksAccount;
  userId: string;
  ttlMs?: number;
  log?: { warn?: (msg: string) => void };
}): Promise<LineWorksUserProfile | null> {
  const { account, userId } = args;
  if (!userId) return null;
  const ttl = args.ttlMs ?? DEFAULT_TTL_MS;
  const now = Date.now();
  const key = cacheKey(account, userId);

  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.profile;

  const access = await getAccessToken(account);
  const url = `${LINEWORKS_API_BASE}/users/${encodeURIComponent(userId)}`;
  const res = await fetch(url, {
    headers: { authorization: `${access.tokenType} ${access.token}` },
  });

  if (res.status === 404) {
    cache.set(key, { profile: null, expiresAt: now + ttl });
    return null;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    args.log?.warn?.(
      `LINE WORKS directory.getUser(${userId}) failed: ${res.status} ${text.slice(0, 120)}`,
    );
    cache.set(key, { profile: null, expiresAt: now + 60_000 });
    return null;
  }

  const raw = (await res.json()) as Record<string, unknown>;
  const profile = extractProfile(userId, raw);
  cache.set(key, { profile, expiresAt: now + ttl });
  return profile;
}

export function clearDirectoryCache(accountId?: string): void {
  if (!accountId) {
    cache.clear();
    return;
  }
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${accountId}:`)) cache.delete(key);
  }
}
