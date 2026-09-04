// Regression cover for the openclaw 2026.9 gateway work-admission gate.
//
// The handler acks LINE WORKS with 204 and then runs the agent turn. From
// openclaw 2026.7, an async chain that inherits an already-released HTTP
// request admission root has its queue enqueues refused with
// "GatewayDrainingError: Gateway is draining; new tasks are not accepted" —
// so every reply was silently dropped. `runDetachedWebhookWork()` must be
// entered synchronously, while the request is still admitted, i.e. BEFORE the
// `requestLifecycle.release()` in the handler's `finally`.
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedLineWorksAccount } from "./types.js";

const SECRET = "bot-secret-xyz";

const state = vi.hoisted(() => ({
  order: [] as string[],
  insideDetached: false,
}));

vi.mock("openclaw/plugin-sdk/webhook-request-guards", () => ({
  // Mirrors the real implementation: reserve the independent root synchronously
  // on entry, then defer the work by a microtask.
  runDetachedWebhookWork: vi.fn(async (run: () => Promise<unknown>) => {
    state.order.push("detached-enter");
    await Promise.resolve();
    state.insideDetached = true;
    try {
      return await run();
    } finally {
      state.insideDetached = false;
    }
  }),
}));

vi.mock("openclaw/plugin-sdk/webhook-ingress", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/webhook-ingress")>();
  return {
    ...actual,
    beginWebhookRequestPipelineOrReject: (params: never) => {
      const result = actual.beginWebhookRequestPipelineOrReject(params);
      if (!result.ok) return result;
      return {
        ok: true as const,
        release: () => {
          state.order.push("release");
          result.release();
        },
      };
    },
  };
});

const { runDetachedWebhookWork } = await import("openclaw/plugin-sdk/webhook-request-guards");
const { createLineWorksWebhookHandler } = await import("./webhook-handler.js");

function account(): ResolvedLineWorksAccount {
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
    allowFrom: [],
    groupAllowFrom: [],
    channels: {},
    extraScopes: [],
    senderProfileEnrichment: false,
    mailPreFetchEnabled: false,
    mailPreFetchCount: 10,
    oauthEnabled: false,
    oauthStartPath: "/oauth/lineworks/start",
    oauthCallbackPath: "/oauth/lineworks/callback",
    oauthScopes: "",
    config: {},
  } as unknown as ResolvedLineWorksAccount;
}

async function postMessage(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  const raw = JSON.stringify({
    type: "message",
    source: { userId: "u-1", domainId: "d-1" },
    content: { type: "text", text: "hi" },
  });
  const req = new EventEmitter() as unknown as IncomingMessage & { headers: Record<string, string> };
  (req as unknown as { method: string }).method = "POST";
  req.headers = {
    "x-works-signature": createHmac("sha256", SECRET).update(raw).digest("base64"),
    "content-length": String(Buffer.byteLength(raw)),
  };
  (req as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress: "127.0.0.1" };

  const res = new EventEmitter() as unknown as ServerResponse & { statusCode?: number };
  (res as { writeHead: unknown }).writeHead = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  (res as { end: unknown }).end = vi.fn();

  const handled = handler(req, res);
  process.nextTick(() => {
    req.emit("data", Buffer.from(raw, "utf8"));
    req.emit("end");
  });
  await handled;
  await new Promise((r) => setImmediate(r));
  return res;
}

describe("webhook-handler — detached gateway work admission", () => {
  beforeEach(() => {
    state.order = [];
    state.insideDetached = false;
    vi.mocked(runDetachedWebhookWork).mockClear();
  });

  it("runs deliver inside runDetachedWebhookWork, entered before the request root is released", async () => {
    const deliver = vi.fn(async () => {
      state.order.push("deliver");
      // Proves deliver runs on the detached root, not the request's.
      expect(state.insideDetached).toBe(true);
      return null;
    });

    const res = await postMessage(createLineWorksWebhookHandler({ account: account(), deliver }));

    expect(res.statusCode).toBe(204);
    expect(runDetachedWebhookWork).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    // The detached root is reserved while the request is still admitted.
    expect(state.order).toEqual(["detached-enter", "release", "deliver"]);
  });

  it("still logs deliver failures raised through the detached root", async () => {
    const error = vi.fn();
    const deliver = vi.fn(async () => {
      throw new Error("boom");
    });

    await postMessage(
      createLineWorksWebhookHandler({
        account: account(),
        deliver,
        log: { info: vi.fn(), warn: vi.fn(), error },
      }),
    );

    expect(error).toHaveBeenCalledWith(expect.stringContaining("deliver failed"));
  });
});
