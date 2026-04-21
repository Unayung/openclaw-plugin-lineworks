import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { exportPKCS8, importSPKI, jwtVerify } from "jose";
import { clearAccessTokenCache, getAccessToken } from "./auth.js";
import type { ResolvedLineWorksAccount } from "./types.js";

function makeAccount(privateKeyPem: string): ResolvedLineWorksAccount {
  return {
    accountId: "default",
    enabled: true,
    clientId: "client-abc",
    clientSecret: "secret-xyz",
    serviceAccount: "svc@example.com",
    privateKey: privateKeyPem,
    botId: "bot-123",
    botSecret: "bot-secret",
    config: {},
  };
}

async function setupKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = await exportPKCS8(privateKey);
  const publicSpki = publicKey.export({ type: "spki", format: "pem" }) as string;
  const verifyKey = await importSPKI(publicSpki, "RS256");
  return { privateKeyPem, verifyKey };
}

describe("getAccessToken", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearAccessTokenCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("posts a signed JWT assertion with the correct OAuth fields and claims", async () => {
    const { privateKeyPem, verifyKey } = await setupKeypair();
    const account = makeAccount(privateKeyPem);
    let capturedBody = "";
    let capturedUrl = "";

    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedBody = (init?.body as URLSearchParams).toString();
      return new Response(
        JSON.stringify({
          access_token: "tkn-1",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "bot",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const token = await getAccessToken(account);
    expect(token.token).toBe("tkn-1");
    expect(capturedUrl).toBe("https://auth.worksmobile.com/oauth2/v2.0/token");

    const params = new URLSearchParams(capturedBody);
    expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(params.get("client_id")).toBe("client-abc");
    expect(params.get("client_secret")).toBe("secret-xyz");
    expect(params.get("scope")).toBe("bot");

    const assertion = params.get("assertion");
    expect(assertion).toBeTruthy();
    const { payload, protectedHeader } = await jwtVerify(assertion!, verifyKey);
    expect(protectedHeader.alg).toBe("RS256");
    expect(payload.iss).toBe("client-abc");
    expect(payload.sub).toBe("svc@example.com");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect((payload.exp as number) - (payload.iat as number)).toBe(60 * 60);
  });

  it("returns the cached token when not near expiry", async () => {
    const { privateKeyPem } = await setupKeypair();
    const account = makeAccount(privateKeyPem);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: "tkn-1", token_type: "Bearer", expires_in: 3600 }),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await getAccessToken(account);
    await getAccessToken(account);
    await getAccessToken(account);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("single-flights concurrent refreshes under contention", async () => {
    const { privateKeyPem } = await setupKeypair();
    const account = makeAccount(privateKeyPem);
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const a = getAccessToken(account);
    const b = getAccessToken(account);
    const c = getAccessToken(account);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    resolveFetch!(
      new Response(
        JSON.stringify({ access_token: "tkn-1", token_type: "Bearer", expires_in: 3600 }),
        { status: 200 },
      ),
    );

    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra.token).toBe("tkn-1");
    expect(rb).toBe(ra);
    expect(rc).toBe(ra);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries cleanly after a failed refresh", async () => {
    const { privateKeyPem } = await setupKeypair();
    const account = makeAccount(privateKeyPem);
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) return new Response("boom", { status: 500 });
      return new Response(
        JSON.stringify({ access_token: "tkn-retry", token_type: "Bearer", expires_in: 3600 }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(getAccessToken(account)).rejects.toThrow(/LINE WORKS auth failed/);
    const token = await getAccessToken(account);
    expect(token.token).toBe("tkn-retry");
    expect(callCount).toBe(2);
  });
});
