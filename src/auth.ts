import { SignJWT, importPKCS8 } from "jose";
import type { LineWorksAccessToken, ResolvedLineWorksAccount } from "./types.js";

const LINEWORKS_AUTH_URL = "https://auth.worksmobile.com/oauth2/v2.0/token";
const TOKEN_SCOPE = "bot";
const JWT_TTL_SECONDS = 60 * 60;
const REFRESH_SKEW_MS = 60_000;

type TokenCacheEntry = {
  token: LineWorksAccessToken;
  refreshing?: Promise<LineWorksAccessToken>;
};

const tokenCache = new Map<string, TokenCacheEntry>();

function cacheKey(account: ResolvedLineWorksAccount): string {
  return `${account.accountId}:${account.clientId}:${account.serviceAccount}`;
}

async function buildAssertion(account: ResolvedLineWorksAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  let key: Awaited<ReturnType<typeof importPKCS8>>;
  try {
    key = await importPKCS8(account.privateKey, "RS256");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const pem = account.privateKey ?? "";
    const hint = !pem
      ? "no private key configured (set channels.lineworks.privateKey, privateKeyFile, or LINEWORKS_PRIVATE_KEY)"
      : !pem.includes("-----BEGIN") || !pem.includes("-----END")
        ? "value does not look like a PEM (missing BEGIN/END markers)"
        : !pem.includes("BEGIN PRIVATE KEY")
          ? "PEM is not PKCS#8; convert with: openssl pkcs8 -topk8 -nocrypt -in src.pem -out pkcs8.pem"
          : "PEM markers are present — likely the body was truncated or re-serialized. Try privateKeyFile pointing at an on-disk .pem";
    throw new Error(
      `LINE WORKS: unable to parse private key for account "${account.accountId}": ${msg} (${hint})`,
    );
  }
  return await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(account.clientId)
    .setSubject(account.serviceAccount)
    .setIssuedAt(now)
    .setExpirationTime(now + JWT_TTL_SECONDS)
    .sign(key);
}

async function requestAccessToken(
  account: ResolvedLineWorksAccount,
): Promise<LineWorksAccessToken> {
  const assertion = await buildAssertion(account);
  const body = new URLSearchParams({
    assertion,
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    client_id: account.clientId,
    client_secret: account.clientSecret,
    scope: TOKEN_SCOPE,
  });

  const res = await fetch(LINEWORKS_AUTH_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LINE WORKS auth failed: ${res.status} ${text}`);
  }
  const json = (await res.json()) as {
    access_token: string;
    token_type: "Bearer";
    expires_in: number;
    scope?: string;
  };
  return {
    token: json.access_token,
    tokenType: json.token_type,
    expiresAt: Date.now() + json.expires_in * 1000,
    scope: json.scope,
  };
}

// Single-flight refresh: concurrent callers seeing an expired token share one
// in-flight request so we do not stampede the auth endpoint. A failure clears
// the shared promise so the next caller retries cleanly.
export async function getAccessToken(
  account: ResolvedLineWorksAccount,
): Promise<LineWorksAccessToken> {
  const key = cacheKey(account);
  const now = Date.now();
  const cached = tokenCache.get(key);

  if (cached?.token && cached.token.expiresAt - now > REFRESH_SKEW_MS) {
    return cached.token;
  }
  if (cached?.refreshing) {
    return await cached.refreshing;
  }

  const entry: TokenCacheEntry = cached ?? ({} as TokenCacheEntry);
  const refreshing = (async () => {
    try {
      const fresh = await requestAccessToken(account);
      entry.token = fresh;
      return fresh;
    } finally {
      entry.refreshing = undefined;
    }
  })();
  entry.refreshing = refreshing;
  tokenCache.set(key, entry);
  return await refreshing;
}

export function clearAccessTokenCache(accountId?: string): void {
  if (!accountId) {
    tokenCache.clear();
    return;
  }
  for (const key of [...tokenCache.keys()]) {
    if (key.startsWith(`${accountId}:`)) tokenCache.delete(key);
  }
}
