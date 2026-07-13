import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { exportPKCS8 } from "jose";
import { clearAccessTokenCache } from "./auth.js";
import {
  deletePersistentMenu,
  getChannelInfo,
  getPersistentMenu,
  registerPersistentMenu,
} from "./bot-extras.js";
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

function mockFetchSequence(responses: Response[]): {
  calls: { url: string; method?: string; headers: Record<string, string>; body?: string }[];
  mock: typeof fetch;
} {
  const calls: { url: string; method?: string; headers: Record<string, string>; body?: string }[] =
    [];
  const queue = [...responses];
  const mock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    calls.push({
      url: url.toString(),
      method: init?.method,
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
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

const originalFetch = globalThis.fetch;

beforeEach(() => {
  clearAccessTokenCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("getChannelInfo", () => {
  it("GETs the channel endpoint and returns room info", async () => {
    const account = await setupAccount();
    const { calls, mock } = mockFetchSequence([
      new Response(
        JSON.stringify({
          domainId: 10000001,
          channelId: "room-9",
          title: "Example title",
          channelType: { type: "MULTI_USERS" },
        }),
        { status: 200 },
      ),
    ]);
    globalThis.fetch = mock;

    const info = await getChannelInfo({ account, channelId: "room-9" });

    expect(info).toEqual({
      domainId: 10000001,
      channelId: "room-9",
      title: "Example title",
      channelType: "MULTI_USERS",
      orgUnitId: undefined,
      groupId: undefined,
    });
    const req = calls.find((c) => c.url.includes("/channels/"));
    expect(req).toBeDefined();
    expect(req!.url).toBe("https://www.worksapis.com/v1.0/bots/bot-1/channels/room-9");
    expect(req!.headers.authorization).toBe("Bearer tkn");
  });

  it("returns null (not a fabricated object) on HTTP error", async () => {
    const account = await setupAccount();
    const warnings: string[] = [];
    const { mock } = mockFetchSequence([new Response("unauthorized", { status: 401 })]);
    globalThis.fetch = mock;

    const info = await getChannelInfo({
      account,
      channelId: "room-9",
      log: { warn: (m) => warnings.push(m) },
    });

    expect(info).toBeNull();
    expect(warnings.join("\n")).toContain("401");
  });
});

describe("registerPersistentMenu", () => {
  it("POSTs the persistent menu content and reports ok:true on 201", async () => {
    const account = await setupAccount();
    const { calls, mock } = mockFetchSequence([
      new Response(JSON.stringify({ content: { actions: [] } }), { status: 201 }),
    ]);
    globalThis.fetch = mock;

    const content = {
      actions: [{ type: "message" as const, label: "Hi", text: "hi", postback: "hi" }],
    };
    const result = await registerPersistentMenu({ account, content });

    expect(result).toEqual({ ok: true });
    const req = calls.find((c) => c.url.includes("/persistentmenu"));
    expect(req).toBeDefined();
    expect(req!.method).toBe("POST");
    expect(req!.url).toBe("https://www.worksapis.com/v1.0/bots/bot-1/persistentmenu");
    expect(JSON.parse(req!.body!)).toEqual({ content });
  });

  it("returns ok:false with a reason on HTTP error", async () => {
    const account = await setupAccount();
    const { mock } = mockFetchSequence([new Response("bad request", { status: 400 })]);
    globalThis.fetch = mock;

    const result = await registerPersistentMenu({
      account,
      content: { actions: [] },
    });

    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toContain("400");
  });
});

describe("getPersistentMenu", () => {
  it("GETs and returns the persistent menu content", async () => {
    const account = await setupAccount();
    const actions = [
      { type: "uri" as const, label: "Example Homepage", uri: "https://example.com" },
    ];
    const { calls, mock } = mockFetchSequence([
      new Response(JSON.stringify({ content: { actions } }), { status: 200 }),
    ]);
    globalThis.fetch = mock;

    const menu = await getPersistentMenu({ account });

    expect(menu).toEqual({ actions });
    const req = calls.find((c) => c.url.includes("/persistentmenu"));
    expect(req!.method).toBeUndefined(); // default GET
    expect(req!.url).toBe("https://www.worksapis.com/v1.0/bots/bot-1/persistentmenu");
  });

  it("returns null on an unexpected response shape", async () => {
    const account = await setupAccount();
    const { mock } = mockFetchSequence([
      new Response(JSON.stringify({ content: {} }), { status: 200 }),
    ]);
    globalThis.fetch = mock;

    const menu = await getPersistentMenu({ account });

    expect(menu).toBeNull();
  });
});

describe("deletePersistentMenu", () => {
  it("DELETEs the persistent menu and reports ok:true on 204", async () => {
    const account = await setupAccount();
    const { calls, mock } = mockFetchSequence([new Response(null, { status: 204 })]);
    globalThis.fetch = mock;

    const result = await deletePersistentMenu({ account });

    expect(result).toEqual({ ok: true });
    const req = calls.find((c) => c.url.includes("/persistentmenu"));
    expect(req!.method).toBe("DELETE");
  });

  it("returns ok:false with a reason on HTTP error", async () => {
    const account = await setupAccount();
    const { mock } = mockFetchSequence([new Response("server error", { status: 500 })]);
    globalThis.fetch = mock;

    const result = await deletePersistentMenu({ account });

    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toContain("500");
  });
});
