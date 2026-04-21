import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { exportPKCS8 } from "jose";
import { clearAccessTokenCache } from "./auth.js";
import { sendMessage, sendText } from "./send.js";
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
    allowFrom: [],
    groupAllowFrom: [],
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
