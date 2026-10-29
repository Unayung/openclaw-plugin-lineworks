import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { exportPKCS8 } from "jose";
import { clearAccessTokenCache } from "./auth.js";
import { clearDirectoryCache, getUserProfile } from "./directory.js";
import type { ResolvedLineWorksAccount } from "./types.js";

async function makeAccount(senderProfileEmail: boolean): Promise<ResolvedLineWorksAccount> {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    accountId: "default",
    enabled: true,
    clientId: "cid",
    clientSecret: "csec",
    serviceAccount: "svc@e.com",
    privateKey: await exportPKCS8(privateKey),
    botId: "bot-1",
    botSecret: "bsec",
    webhookPath: "/lineworks/webhook",
    dmPolicy: "pairing",
    groupPolicy: "allowlist",
    groupRequireMention: false,
    requireMention: false,
    botMentionHandle: undefined,
    allowFrom: [],
    groupAllowFrom: [],
    channels: {},
    extraScopes: [],
    senderProfileEnrichment: true,
    senderProfileEmail,
    mailPreFetchEnabled: false,
    mailPreFetchCount: 10,
    publicBaseUrl: undefined,
    oauthEnabled: false,
    oauthStartPath: "/oauth/lineworks/start",
    oauthCallbackPath: "/oauth/lineworks/callback",
    oauthScopes: "mail,mail.read",
    config: {},
  };
}

function mockUserFetch(): typeof fetch {
  return vi.fn(async (url: string | URL | Request) => {
    if (url.toString().includes("/oauth2/")) {
      return new Response(
        JSON.stringify({ access_token: "tkn", token_type: "Bearer", expires_in: 3600 }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        userId: "u-1",
        email: "u1@example.com",
        userName: { firstName: "太郎", lastName: "ワークス" },
        displayName: "Taro",
        nickName: "tarochan",
        organizations: [
          {
            primary: true,
            position: "Manager",
            orgUnits: [{ orgUnitName: "Sales" }],
          },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

describe("getUserProfile", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearAccessTokenCache();
    clearDirectoryCache();
    globalThis.fetch = mockUserFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("does not expose department, position or nickName even if the API returns them", async () => {
    const account = await makeAccount(true);
    const profile = await getUserProfile({ account, userId: "u-1" });

    expect(profile).not.toBeNull();
    expect(profile).not.toHaveProperty("department");
    expect(profile).not.toHaveProperty("position");
    expect(profile).not.toHaveProperty("nickName");
    expect(profile!.userId).toBe("u-1");
    expect(profile!.displayName).toBe("Taro");
  });

  it("returns email when senderProfileEmail is true", async () => {
    const account = await makeAccount(true);
    const profile = await getUserProfile({ account, userId: "u-1" });
    expect(profile!.email).toBe("u1@example.com");
  });

  it("leaves email undefined when senderProfileEmail is false", async () => {
    const account = await makeAccount(false);
    const profile = await getUserProfile({ account, userId: "u-1" });
    expect(profile!.email).toBeUndefined();
    expect(profile!.displayName).toBe("Taro");
  });
});
