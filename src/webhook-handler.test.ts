import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createLineWorksWebhookHandler } from "./webhook-handler.js";
import type { LineWorksInboundMessage } from "./inbound-context.js";
import type { ResolvedLineWorksAccount } from "./types.js";

const SECRET = "bot-secret-xyz";

function baseAccount(overrides: Partial<ResolvedLineWorksAccount> = {}): ResolvedLineWorksAccount {
  return {
    accountId: "default",
    enabled: true,
    clientId: "cid",
    clientSecret: "csec",
    serviceAccount: "svc@e.com",
    privateKey: "PEM",
    botId: "bot-1",
    botSecret: SECRET,
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
    oauthScopes: "",
    config: {},
    ...overrides,
  };
}

function makeRes() {
  const res = new EventEmitter() as unknown as ServerResponse & {
    statusCode?: number;
  };
  // Cast through `any` — vitest mocks don't match the overloaded http types
  // exactly, but the handler only calls these via the documented surface.
  (res as { writeHead: unknown }).writeHead = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  (res as { end: unknown }).end = vi.fn();
  return res;
}

async function postEvent(
  handler: ReturnType<typeof createLineWorksWebhookHandler>,
  body: Record<string, unknown>,
): Promise<{ statusCode?: number }> {
  const raw = JSON.stringify(body);
  const signature = createHmac("sha256", SECRET).update(raw).digest("base64");
  const req = new EventEmitter() as unknown as IncomingMessage & { headers: Record<string, string> };
  (req as unknown as { method: string }).method = "POST";
  req.headers = { "x-works-signature": signature, "content-length": String(Buffer.byteLength(raw)) };
  (req as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress: "127.0.0.1" };

  const res = makeRes();
  const handled = handler(req, res);

  process.nextTick(() => {
    req.emit("data", Buffer.from(raw, "utf8"));
    req.emit("end");
  });

  await handled;
  // Let the fire-and-forget deliver() microtask drain.
  await new Promise((r) => setImmediate(r));
  return { statusCode: res.statusCode };
}

function channelMessage(channelId: string, userId: string, text = "hi") {
  return {
    type: "message",
    source: { channelId, userId, domainId: "d-1" },
    content: { type: "text", text },
  };
}

describe("webhook-handler — group preflight", () => {
  it("blocks channel-message when groupPolicy=allowlist + channel not listed", async () => {
    const deliver = vi.fn().mockResolvedValue(null);
    const handler = createLineWorksWebhookHandler({
      account: baseAccount({ channels: { C1: { enabled: true, requireMention: undefined, users: [] } } }),
      deliver,
    });
    const result = await postEvent(handler, channelMessage("C2", "U1"));
    expect(result.statusCode).toBe(204);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("allows when channel id matches and users list empty", async () => {
    const deliver = vi.fn().mockResolvedValue(null);
    const handler = createLineWorksWebhookHandler({
      account: baseAccount({ channels: { C1: { enabled: true, requireMention: undefined, users: [] } } }),
      deliver,
    });
    const result = await postEvent(handler, channelMessage("C1", "U1"));
    expect(result.statusCode).toBe(204);
    expect(deliver).toHaveBeenCalledTimes(1);
    const msg = deliver.mock.calls[0]![0] as LineWorksInboundMessage;
    expect(msg.conversationId).toBe("C1");
    expect(msg.from).toBe("U1");
  });

  it("blocks sender not in per-channel users allowlist", async () => {
    const deliver = vi.fn().mockResolvedValue(null);
    const handler = createLineWorksWebhookHandler({
      account: baseAccount({
        channels: { C1: { enabled: true, requireMention: undefined, users: ["U1", "U2"] } },
      }),
      deliver,
    });
    const allowed = await postEvent(handler, channelMessage("C1", "U1"));
    const blocked = await postEvent(handler, channelMessage("C1", "U99"));
    expect(allowed.statusCode).toBe(204);
    expect(blocked.statusCode).toBe(204);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("'*' wildcard entry applies when channelId not listed", async () => {
    const deliver = vi.fn().mockResolvedValue(null);
    const handler = createLineWorksWebhookHandler({
      account: baseAccount({
        channels: { "*": { enabled: true, requireMention: undefined, users: ["U1"] } },
      }),
      deliver,
    });
    const ok = await postEvent(handler, channelMessage("C-anything", "U1"));
    const no = await postEvent(handler, channelMessage("C-anything", "U2"));
    expect(ok.statusCode).toBe(204);
    expect(no.statusCode).toBe(204);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("groupPolicy=disabled blocks regardless of channels map", async () => {
    const deliver = vi.fn().mockResolvedValue(null);
    const handler = createLineWorksWebhookHandler({
      account: baseAccount({
        groupPolicy: "disabled",
        channels: { C1: { enabled: true, requireMention: undefined, users: ["U1"] } },
      }),
      deliver,
    });
    const result = await postEvent(handler, channelMessage("C1", "U1"));
    expect(result.statusCode).toBe(204);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("groupPolicy=open allows even without channels entry", async () => {
    const deliver = vi.fn().mockResolvedValue(null);
    const handler = createLineWorksWebhookHandler({
      account: baseAccount({ groupPolicy: "open" }),
      deliver,
    });
    const result = await postEvent(handler, channelMessage("C-novel", "U-novel"));
    expect(result.statusCode).toBe(204);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("falls back to account-level groupAllowFrom when channels is empty", async () => {
    const deliver = vi.fn().mockResolvedValue(null);
    const handler = createLineWorksWebhookHandler({
      account: baseAccount({ groupPolicy: "open", groupAllowFrom: ["U1"] }),
      deliver,
    });
    const ok = await postEvent(handler, channelMessage("C1", "U1"));
    const no = await postEvent(handler, channelMessage("C1", "U2"));
    expect(ok.statusCode).toBe(204);
    expect(no.statusCode).toBe(204);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("per-channel requireMention overrides account-level", async () => {
    const deliver = vi.fn().mockResolvedValue(null);
    const handler = createLineWorksWebhookHandler({
      account: baseAccount({
        requireMention: false,
        botMentionHandle: "Racco",
        channels: { C1: { enabled: true, requireMention: true, users: [] } },
      }),
      deliver,
    });
    const withMention = await postEvent(handler, channelMessage("C1", "U1", "hey @Racco help"));
    const without = await postEvent(handler, channelMessage("C1", "U1", "just chatting"));
    expect(withMention.statusCode).toBe(204);
    expect(without.statusCode).toBe(204);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("user-message (DM) is not affected by group preflight", async () => {
    const deliver = vi.fn().mockResolvedValue(null);
    const handler = createLineWorksWebhookHandler({
      account: baseAccount({
        groupPolicy: "disabled",
        channels: {},
      }),
      deliver,
    });
    const result = await postEvent(handler, {
      type: "message",
      source: { userId: "U1", domainId: "d-1" },
      content: { type: "text", text: "hi" },
    });
    expect(result.statusCode).toBe(204);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
