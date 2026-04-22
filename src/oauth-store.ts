import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A LINE WORKS OAuth token bundle for a single end user. Stored as JSON per
 * (accountId, userId) under `~/.openclaw/credentials/lineworks-oauth/`.
 *
 * `expiresAt` is the wall-clock ms epoch when the access token expires.
 * We refresh a few seconds before that using `refreshToken`.
 */
export interface LineWorksOAuthToken {
  userId: string;
  email?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenType: "Bearer" | string;
  scope?: string;
  grantedAt: string;
  /** When we last successfully refreshed, for observability. */
  refreshedAt?: string;
}

function openclawHome(): string {
  return process.env.OPENCLAW_HOME?.trim() || path.join(os.homedir(), ".openclaw");
}

function tokenDir(accountId: string): string {
  return path.join(openclawHome(), "credentials", "lineworks-oauth", accountId);
}

function tokenPath(accountId: string, userId: string): string {
  return path.join(tokenDir(accountId), `${encodeURIComponent(userId)}.json`);
}

async function ensureDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
}

/**
 * Save a token bundle atomically (write to tmp + rename). File mode 0600 so
 * only the owning user can read the refresh token. Caller is responsible for
 * token freshness; this just persists.
 */
export async function saveOAuthToken(
  accountId: string,
  token: LineWorksOAuthToken,
): Promise<void> {
  const dir = tokenDir(accountId);
  await ensureDir(dir);
  const dest = tokenPath(accountId, token.userId);
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify(token, null, 2);
  await fs.promises.writeFile(tmp, body, { mode: 0o600 });
  await fs.promises.rename(tmp, dest);
}

export async function loadOAuthToken(
  accountId: string,
  userId: string,
): Promise<LineWorksOAuthToken | null> {
  try {
    const body = await fs.promises.readFile(tokenPath(accountId, userId), "utf8");
    const parsed = JSON.parse(body) as LineWorksOAuthToken;
    if (!parsed.accessToken || !parsed.refreshToken || !parsed.userId) return null;
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

export async function deleteOAuthToken(
  accountId: string,
  userId: string,
): Promise<boolean> {
  try {
    await fs.promises.unlink(tokenPath(accountId, userId));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw err;
  }
}

export async function listOAuthUsers(accountId: string): Promise<string[]> {
  try {
    const names = await fs.promises.readdir(tokenDir(accountId));
    return names
      .filter((n) => n.endsWith(".json"))
      .map((n) => decodeURIComponent(n.replace(/\.json$/, "")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
}
