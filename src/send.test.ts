import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { exportPKCS8 } from "jose";
import { clearAccessTokenCache } from "./auth.js";
import { buildTextOutboundMessages, sendMessage, sendText } from "./send.js";
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

function mockFetchSequence(): {
  calls: { url: string; method?: string; headers: Record<string, string>; body?: string }[];
  mock: typeof fetch;
} {
  const calls: { url: string; method?: string; headers: Record<string, string>; body?: string }[] =
    [];
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
      body: init?.body as string | undefined,
    });
    if (url.toString().includes("/oauth2/")) {
      return new Response(
        JSON.stringify({ access_token: "tkn", token_type: "Bearer", expires_in: 3600 }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, mock };
}

describe("sendMessage", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearAccessTokenCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("POSTs to the user messages endpoint with bearer token and content envelope", async () => {
    const account = await setupAccount();
    const { calls, mock } = mockFetchSequence();
    globalThis.fetch = mock;

    await sendMessage({
      account,
      target: { type: "user", userId: "user-42" },
      message: { type: "text", text: "hi" },
    });

    const send = calls.find((c) => c.url.includes("/bots/"));
    expect(send).toBeDefined();
    expect(send!.url).toBe("https://www.worksapis.com/v1.0/bots/bot-1/users/user-42/messages");
    expect(send!.method).toBe("POST");
    expect(send!.headers.authorization).toBe("Bearer tkn");
    expect(send!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(send!.body!)).toEqual({
      content: { type: "text", text: "hi" },
    });
  });

  it("POSTs to the channel messages endpoint for channel targets", async () => {
    const account = await setupAccount();
    const { calls, mock } = mockFetchSequence();
    globalThis.fetch = mock;

    await sendMessage({
      account,
      target: { type: "channel", channelId: "room-9" },
      message: { type: "text", text: "yo" },
    });

    const send = calls.find((c) => c.url.includes("/bots/"));
    expect(send!.url).toBe("https://www.worksapis.com/v1.0/bots/bot-1/channels/room-9/messages");
  });

  it("url-encodes ids with special characters", async () => {
    const account = await setupAccount();
    const { calls, mock } = mockFetchSequence();
    globalThis.fetch = mock;

    await sendMessage({
      account,
      target: { type: "user", userId: "u/with slash" },
      message: { type: "text", text: "hi" },
    });

    const send = calls.find((c) => c.url.includes("/bots/"));
    expect(send!.url).toContain("/users/u%2Fwith%20slash/messages");
  });

  it("throws a descriptive error on non-2xx response", async () => {
    const account = await setupAccount();
    const mock = vi.fn(async (url: string | URL | Request) => {
      if (url.toString().includes("/oauth2/")) {
        return new Response(
          JSON.stringify({ access_token: "t", token_type: "Bearer", expires_in: 3600 }),
          { status: 200 },
        );
      }
      return new Response("nope", { status: 400 });
    }) as unknown as typeof fetch;
    globalThis.fetch = mock;

    await expect(
      sendMessage({
        account,
        target: { type: "user", userId: "u" },
        message: { type: "text", text: "x" },
      }),
    ).rejects.toThrow(/LINE WORKS send failed: 400 nope/);
  });
});

describe("sendText", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearAccessTokenCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("does not chunk short text", async () => {
    const account = await setupAccount();
    const { calls, mock } = mockFetchSequence();
    globalThis.fetch = mock;

    await sendText({ account, target: { type: "user", userId: "u" }, text: "short" });
    const sends = calls.filter((c) => c.url.includes("/bots/"));
    expect(sends).toHaveLength(1);
  });

  it("expands the sticker: shorthand (quoted) into a sticker message", async () => {
    const account = await setupAccount();
    const { calls, mock } = mockFetchSequence();
    globalThis.fetch = mock;

    await sendText({
      account,
      target: { type: "user", userId: "u" },
      text: 'sticker:"584:4443"',
    });

    const sends = calls.filter((c) => c.url.includes("/bots/"));
    expect(sends).toHaveLength(1);
    expect(JSON.parse(sends[0]!.body!)).toEqual({
      content: { type: "sticker", packageId: "584", stickerId: "4443" },
    });
  });

  it("expands the sticker: shorthand (unquoted, surrounding whitespace) too", async () => {
    const account = await setupAccount();
    const { calls, mock } = mockFetchSequence();
    globalThis.fetch = mock;

    await sendText({
      account,
      target: { type: "user", userId: "u" },
      text: "  sticker:7482:13835647  ",
    });

    const sends = calls.filter((c) => c.url.includes("/bots/"));
    expect(JSON.parse(sends[0]!.body!).content).toEqual({
      type: "sticker",
      packageId: "7482",
      stickerId: "13835647",
    });
  });

  it("treats sticker-like text that is not the exact shorthand as plain text", async () => {
    const account = await setupAccount();
    const { calls, mock } = mockFetchSequence();
    globalThis.fetch = mock;

    await sendText({
      account,
      target: { type: "user", userId: "u" },
      text: "send me sticker:584:4443 please",
    });

    const sends = calls.filter((c) => c.url.includes("/bots/"));
    expect(JSON.parse(sends[0]!.body!).content.type).toBe("text");
  });

  it("chunks text longer than 2000 chars and prefers newline boundaries", async () => {
    const account = await setupAccount();
    const { calls, mock } = mockFetchSequence();
    globalThis.fetch = mock;

    const line = "x".repeat(1200);
    const text = `${line}\n${line}\n${line}`;
    await sendText({ account, target: { type: "user", userId: "u" }, text });

    const sends = calls.filter((c) => c.url.includes("/bots/"));
    expect(sends.length).toBeGreaterThan(1);

    for (const call of sends) {
      const parsed = JSON.parse(call.body!);
      expect(parsed.content.type).toBe("text");
      expect(parsed.content.text.length).toBeLessThanOrEqual(2000);
    }
    const concatenated = sends
      .map((c) => JSON.parse(c.body!).content.text)
      .join("");
    expect(concatenated).toBe(text);
  });
});

describe("buildTextOutboundMessages", () => {
  it("strips a quick_replies directive and attaches chips to the message", () => {
    const messages = buildTextOutboundMessages(
      "你想哪種角色？ [[quick_replies: 社群小編, 資料分析師, 客服專員]]",
    );
    expect(messages).toHaveLength(1);
    const [msg] = messages;
    if (!msg || msg.type !== "text") throw new Error("expected a text message");
    expect(msg.text).toBe("你想哪種角色？");
    expect(msg.text).not.toContain("[[quick_replies");
    expect(msg.quickReply?.items).toHaveLength(3);
  });

  it("handles emoji-keycap labels", () => {
    const messages = buildTextOutboundMessages(
      "選一個 [[quick_replies: 1️⃣ 社群小編, 2️⃣ 資料分析師, 3️⃣ 客服專員]]",
    );
    const [msg] = messages;
    if (!msg || msg.type !== "text") throw new Error("expected a text message");
    expect(msg.text).not.toContain("[[quick_replies");
    expect(msg.quickReply?.items).toHaveLength(3);
  });

  it("attaches chips only to the last chunk of a long reply", () => {
    const long = "a".repeat(2500);
    const messages = buildTextOutboundMessages(`${long} [[quick_replies: Yes, No]]`);
    expect(messages.length).toBeGreaterThan(1);
    const first = messages[0];
    if (!first || first.type !== "text") throw new Error("expected a text message");
    expect(first.quickReply).toBeUndefined();
    const last = messages[messages.length - 1];
    if (!last || last.type !== "text") throw new Error("expected a text message");
    expect(last.quickReply?.items).toHaveLength(2);
  });

  it("returns a plain text message when there is no directive", () => {
    expect(buildTextOutboundMessages("just text")).toEqual([{ type: "text", text: "just text" }]);
  });

  it("carries chips on a minimal message when the reply is directive-only", () => {
    const messages = buildTextOutboundMessages("[[quick_replies: A, B]]");
    expect(messages).toHaveLength(1);
    const [msg] = messages;
    if (!msg || msg.type !== "text") throw new Error("expected a text message");
    expect(msg.quickReply?.items).toHaveLength(2);
  });

  it("renders a flex directive as a flex message, ordered after text", () => {
    const messages = buildTextOutboundMessages('here [[flex: my card ||| {"type":"bubble"}]]');
    expect(messages.map((m) => m.type)).toEqual(["text", "flex"]);
    const flex = messages.find((m) => m.type === "flex");
    expect(flex).toMatchObject({ type: "flex", altText: "my card" });
  });

  it("renders a location directive as a location message", () => {
    const messages = buildTextOutboundMessages(
      "meet here [[location: Taipei 101 | No. 7 Xinyi Rd | 25.0330 | 121.5654]]",
    );
    const loc = messages.find((m) => m.type === "location");
    expect(loc).toMatchObject({ type: "location", title: "Taipei 101", latitude: 25.033 });
  });

  it("attaches chips to the last message even when it is a flex card", () => {
    const messages = buildTextOutboundMessages(
      'card [[flex: c ||| {"type":"bubble"}]] [[quick_replies: A, B]]',
    );
    const last = messages[messages.length - 1];
    expect(last?.type).toBe("flex");
    expect((last as { quickReply?: { items: unknown[] } }).quickReply?.items).toHaveLength(2);
  });

  it("prefixes group chip actions with the bot mention (label stays clean)", () => {
    const messages = buildTextOutboundMessages("選一個 [[quick_replies: 社群小編, 客服專員]]", {
      groupMentionHandle: "Raccoon AI Crew",
    });
    const [msg] = messages;
    if (!msg || msg.type !== "text") throw new Error("expected a text message");
    const items = msg.quickReply?.items ?? [];
    expect(items.map((i) => (i.action.type === "message" ? i.action.text : ""))).toEqual([
      "@Raccoon AI Crew 社群小編",
      "@Raccoon AI Crew 客服專員",
    ]);
    expect(items.map((i) => i.action.label)).toEqual(["社群小編", "客服專員"]);
  });

  it("leaves chip actions un-mentioned when no groupMentionHandle (DM)", () => {
    const messages = buildTextOutboundMessages("選一個 [[quick_replies: A, B]]");
    const [msg] = messages;
    if (!msg || msg.type !== "text") throw new Error("expected a text message");
    const items = msg.quickReply?.items ?? [];
    expect(items.map((i) => (i.action.type === "message" ? i.action.text : ""))).toEqual(["A", "B"]);
  });
});
