import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { exportPKCS8 } from "jose";
import { clearAccessTokenCache } from "./auth.js";
import { getChannelMembers } from "./members.js";
import type { ResolvedLineWorksAccount } from "./types.js";

function makeAccount(privateKeyPem: string): ResolvedLineWorksAccount {
  return {
    accountId: "default",
    enabled: true,
    clientId: "cid",
    clientSecret: "csec",
    serviceAccount: "svc@e.com",
    privateKey: privateKeyPem,
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

async function setupAccount() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = await exportPKCS8(privateKey);
  return makeAccount(privateKeyPem);
}

function mockFetchSequence(memberResponses: Response[]): {
  calls: { url: string; method?: string; headers: Record<string, string> }[];
  mock: typeof fetch;
} {
  const calls: { url: string; method?: string; headers: Record<string, string> }[] = [];
  const queue = [...memberResponses];
  const mock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    calls.push({ url: url.toString(), method: init?.method, headers });
    if (url.toString().includes("/oauth2/")) {
      return new Response(
        JSON.stringify({ access_token: "tkn", token_type: "Bearer", expires_in: 3600 }),
        { status: 200 },
      );
    }
    return queue.shift() ?? new Response("{}", { status: 500 });
  }) as unknown as typeof fetch;
  return { calls, mock };
}

function membersPage(members: string[], nextCursor?: string): Response {
  return new Response(
    JSON.stringify({
      members,
      responseMetaData: nextCursor !== undefined ? { nextCursor } : undefined,
    }),
    { status: 200 },
  );
}

describe("getChannelMembers", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearAccessTokenCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("GETs the channel members endpoint and returns userIds minus the bot", async () => {
    const account = await setupAccount();
    const { calls, mock } = mockFetchSequence([membersPage(["u-1", "bot-1", "u-2"])]);
    globalThis.fetch = mock;

    const members = await getChannelMembers({ account, channelId: "room-9" });

    expect(members).toEqual(["u-1", "u-2"]);
    const req = calls.find((c) => c.url.includes("/members"));
    expect(req).toBeDefined();
    expect(req!.url).toBe(
      "https://www.worksapis.com/v1.0/bots/bot-1/channels/room-9/members?count=100",
    );
    expect(req!.headers.authorization).toBe("Bearer tkn");
  });

  it("follows nextCursor across pages and concatenates members", async () => {
    const account = await setupAccount();
    const { calls, mock } = mockFetchSequence([
      membersPage(["u-1", "u-2"], "cur-2"),
      membersPage(["u-3"], ""),
    ]);
    globalThis.fetch = mock;

    const members = await getChannelMembers({ account, channelId: "room-9" });

    expect(members).toEqual(["u-1", "u-2", "u-3"]);
    const memberCalls = calls.filter((c) => c.url.includes("/members"));
    expect(memberCalls).toHaveLength(2);
    expect(memberCalls[1]!.url).toContain("cursor=cur-2");
  });

  it("returns null (not an empty roster) on 401", async () => {
    const account = await setupAccount();
    const warnings: string[] = [];
    const { mock } = mockFetchSequence([new Response("unauthorized", { status: 401 })]);
    globalThis.fetch = mock;

    const members = await getChannelMembers({
      account,
      channelId: "room-9",
      log: { warn: (m) => warnings.push(m) },
    });

    expect(members).toBeNull();
    expect(members).not.toEqual([]);
    expect(warnings.join("\n")).toContain("401");
  });

  it("returns null when a later page fails — partial rosters are failures", async () => {
    const account = await setupAccount();
    const { mock } = mockFetchSequence([
      membersPage(["u-1"], "cur-2"),
      new Response("boom", { status: 500 }),
    ]);
    globalThis.fetch = mock;

    const members = await getChannelMembers({ account, channelId: "room-9" });

    expect(members).toBeNull();
  });

  it("returns null on an unexpected response shape", async () => {
    const account = await setupAccount();
    const { mock } = mockFetchSequence([
      new Response(JSON.stringify({ members: [{ userId: "u-1" }] }), { status: 200 }),
    ]);
    globalThis.fetch = mock;

    const members = await getChannelMembers({ account, channelId: "room-9" });

    expect(members).toBeNull();
  });
});
