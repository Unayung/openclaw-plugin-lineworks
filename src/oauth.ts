import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type LineWorksOAuthToken,
  loadOAuthToken,
  saveOAuthToken,
} from "./oauth-store.js";
import { sendText } from "./send.js";
import type { ResolvedLineWorksAccount } from "./types.js";

const LINEWORKS_AUTH_BASE = "https://auth.worksmobile.com";
const LINEWORKS_AUTHORIZE_URL = `${LINEWORKS_AUTH_BASE}/oauth2/v2.0/authorize`;
const LINEWORKS_TOKEN_URL = `${LINEWORKS_AUTH_BASE}/oauth2/v2.0/token`;
const STATE_TTL_MS = 10 * 60 * 1000; // 10 min
const REFRESH_SKEW_MS = 60_000;

interface StateEntry {
  userId: string;
  accountId: string;
  createdAt: number;
}

/**
 * In-memory state store. Not persisted — if the gateway restarts mid-flow
 * the user just re-taps the start link. TTL prunes ensure memory stays
 * bounded even if users abandon half-flows.
 */
const stateStore = new Map<string, StateEntry>();

function pruneStateStore(now: number): void {
  for (const [k, v] of stateStore) {
    if (now - v.createdAt > STATE_TTL_MS) stateStore.delete(k);
  }
}

function makeState(): string {
  return crypto.randomBytes(24).toString("base64url");
}

function buildRedirectUri(account: ResolvedLineWorksAccount): string {
  if (!account.publicBaseUrl) {
    throw new Error(
      "LINE WORKS OAuth: publicBaseUrl is required when oauth.enabled=true",
    );
  }
  return `${account.publicBaseUrl}${account.oauthCallbackPath}`;
}

export function buildOAuthStartLink(
  account: ResolvedLineWorksAccount,
  userId: string,
): string {
  if (!account.publicBaseUrl) {
    throw new Error("LINE WORKS OAuth: publicBaseUrl is required to build start link");
  }
  const qs = new URLSearchParams({ user: userId });
  return `${account.publicBaseUrl}${account.oauthStartPath}?${qs.toString()}`;
}

/**
 * Start handler: validate the `user` query param, generate + store state,
 * redirect the browser to LINE WORKS consent screen. No scope re-negotiation
 * here — we always request the account's full configured scope bundle.
 */
export async function handleOAuthStart(args: {
  req: IncomingMessage;
  res: ServerResponse;
  account: ResolvedLineWorksAccount;
  log?: { info?: (m: string) => void; warn?: (m: string) => void };
}): Promise<void> {
  const { req, res, account, log } = args;
  pruneStateStore(Date.now());

  const url = new URL(req.url || "/", "http://localhost");
  const userId = url.searchParams.get("user")?.trim();
  if (!userId) {
    res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
    res.end(renderErrorPage("Missing `user` query parameter."));
    return;
  }

  const state = makeState();
  stateStore.set(state, { userId, accountId: account.accountId, createdAt: Date.now() });

  const qs = new URLSearchParams({
    client_id: account.clientId,
    redirect_uri: buildRedirectUri(account),
    response_type: "code",
    scope: account.oauthScopes,
    state,
  });
  const authUrl = `${LINEWORKS_AUTHORIZE_URL}?${qs.toString()}`;
  log?.info?.(
    `LINE WORKS OAuth: start for user=${userId.slice(0, 8)}… → redirect to authorize URL`,
  );
  res.writeHead(302, { location: authUrl });
  res.end();
}

/**
 * Callback handler: validate state, exchange code for tokens, persist,
 * optionally DM the user confirmation via the bot.
 */
export async function handleOAuthCallback(args: {
  req: IncomingMessage;
  res: ServerResponse;
  account: ResolvedLineWorksAccount;
  log?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
}): Promise<void> {
  const { req, res, account, log } = args;
  pruneStateStore(Date.now());

  const url = new URL(req.url || "/", "http://localhost");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  if (errorParam) {
    const desc = url.searchParams.get("error_description") ?? "";
    log?.warn?.(`LINE WORKS OAuth: user denied or error: ${errorParam} ${desc}`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      renderErrorPage(
        `LINE WORKS 端回報：${errorParam}${desc ? ` — ${desc}` : ""}。請回到聊天視窗重新發起授權。`,
      ),
    );
    return;
  }

  if (!code || !state) {
    res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
    res.end(renderErrorPage("Missing `code` or `state` in callback."));
    return;
  }

  const entry = stateStore.get(state);
  if (!entry) {
    res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
    res.end(renderErrorPage("這個授權連結已失效（state 過期或錯誤）。請重新發起授權。"));
    return;
  }
  stateStore.delete(state);

  try {
    const tokens = await exchangeAuthCode({
      account,
      code,
      redirectUri: buildRedirectUri(account),
    });
    const token: LineWorksOAuthToken = {
      userId: entry.userId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenType: tokens.token_type,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      scope: tokens.scope,
      grantedAt: new Date().toISOString(),
    };
    await saveOAuthToken(account.accountId, token);
    log?.info?.(
      `LINE WORKS OAuth: granted for user=${entry.userId.slice(0, 8)}… scope="${tokens.scope ?? account.oauthScopes}"`,
    );

    // Best-effort: DM the user a confirmation so they know Racco can now
    // act. Failures here don't affect the grant.
    try {
      await sendText({
        account,
        target: { type: "user", userId: entry.userId },
        text: "✅ 授權完成！現在可以請我幫你看信箱、行程、任務了 🦞",
      });
    } catch (err) {
      log?.warn?.(`LINE WORKS OAuth: confirmation DM failed: ${String(err)}`);
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderSuccessPage());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.error?.(`LINE WORKS OAuth: token exchange failed: ${msg}`);
    res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
    res.end(renderErrorPage(`授權交換失敗：${msg.slice(0, 200)}`));
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

async function exchangeAuthCode(args: {
  account: ResolvedLineWorksAccount;
  code: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    client_id: args.account.clientId,
    client_secret: args.account.clientSecret,
    redirect_uri: args.redirectUri,
  });
  const res = await fetch(LINEWORKS_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`token exchange ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as TokenResponse;
}

async function refreshAccessToken(args: {
  account: ResolvedLineWorksAccount;
  refreshToken: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
    client_id: args.account.clientId,
    client_secret: args.account.clientSecret,
  });
  const res = await fetch(LINEWORKS_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`token refresh ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as TokenResponse;
}

/**
 * Get a live access token for the given LINE WORKS user, refreshing if needed.
 * Returns null if the user hasn't granted OAuth yet. Throws on refresh failure
 * (caller should re-prompt the user to re-grant).
 */
export async function getUserAccessToken(args: {
  account: ResolvedLineWorksAccount;
  userId: string;
  log?: { info?: (m: string) => void; warn?: (m: string) => void };
}): Promise<{ token: string; scope?: string } | null> {
  const { account, userId, log } = args;
  const stored = await loadOAuthToken(account.accountId, userId);
  if (!stored) return null;

  const now = Date.now();
  if (stored.expiresAt - now > REFRESH_SKEW_MS) {
    return { token: stored.accessToken, scope: stored.scope };
  }

  log?.info?.(`LINE WORKS OAuth: refreshing token for user=${userId.slice(0, 8)}…`);
  try {
    const fresh = await refreshAccessToken({ account, refreshToken: stored.refreshToken });
    const updated: LineWorksOAuthToken = {
      ...stored,
      accessToken: fresh.access_token,
      refreshToken: fresh.refresh_token || stored.refreshToken,
      tokenType: fresh.token_type,
      expiresAt: Date.now() + fresh.expires_in * 1000,
      scope: fresh.scope ?? stored.scope,
      refreshedAt: new Date().toISOString(),
    };
    await saveOAuthToken(account.accountId, updated);
    return { token: updated.accessToken, scope: updated.scope };
  } catch (err) {
    log?.warn?.(`LINE WORKS OAuth: refresh failed for ${userId}: ${String(err)}`);
    throw err;
  }
}

function renderSuccessPage(): string {
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>授權完成</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         padding: 40px 24px; max-width: 480px; margin: 0 auto; color: #1a1a1a; }
  h1 { font-size: 22px; }
  p { color: #555; line-height: 1.6; }
  .emoji { font-size: 44px; }
</style></head>
<body>
<div class="emoji">🦞✅</div>
<h1>授權完成！</h1>
<p>Racco 已經拿到你的 LINE WORKS 授權，可以回到聊天視窗跟我說「查看我的信箱」之類的了。</p>
<p style="color:#999;font-size:13px;">可以安全關閉這個頁面。</p>
</body></html>`;
}

function renderErrorPage(message: string): string {
  const safe = message.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>授權失敗</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         padding: 40px 24px; max-width: 480px; margin: 0 auto; color: #1a1a1a; }
  h1 { font-size: 22px; }
  p { color: #555; line-height: 1.6; }
  .emoji { font-size: 44px; }
</style></head>
<body>
<div class="emoji">🦞⚠️</div>
<h1>授權失敗</h1>
<p>${safe}</p>
</body></html>`;
}
