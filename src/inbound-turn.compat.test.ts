// Regression cover for the openclaw 2026.9 plugin-runtime config rename.
//
// `PluginRuntime["config"]` used to expose `loadConfig()`; from 2026.7 it only
// has `current / mutateConfigFile / replaceConfigFile`. The runtime stub below
// deliberately provides ONLY `current`, so any reintroduced `loadConfig()` call
// throws instead of silently dropping the inbound turn after the webhook was
// already acked.
import { describe, expect, it, vi } from "vitest";
import { dispatchLineWorksInboundTurn } from "./inbound-turn.js";
import { setLineWorksRuntime } from "./runtime.js";
import type { LineWorksInboundMessage } from "./inbound-context.js";
import type { ResolvedLineWorksAccount } from "./types.js";

const CFG = { session: { identityLinks: { lineworks: ["u-1"] } } };

function stubAccount(): ResolvedLineWorksAccount {
  return {
    accountId: "default",
    enabled: true,
    clientId: "cid",
    clientSecret: "csec",
    serviceAccount: "svc@e.com",
    privateKey: "PEM",
    botId: "bot-1",
    botSecret: "sec",
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
    // Keep the turn fully offline: no directory lookup, no thinking-ack timer.
    senderProfileEnrichment: false,
    mailPreFetchEnabled: false,
    mailPreFetchCount: 10,
    publicBaseUrl: undefined,
    oauthEnabled: false,
    oauthStartPath: "/oauth/lineworks/start",
    oauthCallbackPath: "/oauth/lineworks/callback",
    oauthScopes: "",
    config: { thinkingAck: { delayMs: 0 } },
  } as unknown as ResolvedLineWorksAccount;
}

function stubMsg(): LineWorksInboundMessage {
  return {
    body: "hello",
    from: "u-1",
    senderName: "u-1",
    conversationId: "u-1",
    chatType: "direct",
    accountId: "default",
    commandAuthorized: true,
  } as unknown as LineWorksInboundMessage;
}

describe("dispatchLineWorksInboundTurn — plugin runtime config accessor", () => {
  it("reads config through rt.config.current() and threads it downstream", async () => {
    const current = vi.fn(() => CFG);
    const resolveAgentRoute = vi.fn(() => ({ agentId: "agent-1" }));
    const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
    const dispatchReply = vi.fn(async () => undefined);

    setLineWorksRuntime({
      // Intentionally no `loadConfig` — matches openclaw >=2026.7.
      config: { current, mutateConfigFile: vi.fn(), replaceConfigFile: vi.fn() },
      channel: {
        routing: { resolveAgentRoute },
        reply: {
          finalizeInboundContext,
          dispatchReplyWithBufferedBlockDispatcher: dispatchReply,
        },
      },
    } as never);

    await dispatchLineWorksInboundTurn({ account: stubAccount(), msg: stubMsg() });

    expect(current).toHaveBeenCalledTimes(1);
    // The snapshot `current()` returned is the one routing and reply dispatch see.
    expect(resolveAgentRoute).toHaveBeenCalledWith(expect.objectContaining({ cfg: CFG }));
    expect(dispatchReply).toHaveBeenCalledWith(expect.objectContaining({ cfg: CFG }));
  });
});
