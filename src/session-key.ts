import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";

const CHANNEL_ID = "lineworks";

export function buildLineWorksInboundSessionKey(params: {
  agentId: string;
  accountId: string;
  sourceKind: "user" | "channel";
  sourceId: string;
  identityLinks?: Record<string, string[]>;
}): string {
  return buildAgentSessionKey({
    agentId: params.agentId,
    channel: CHANNEL_ID,
    accountId: params.accountId,
    peer: {
      kind: params.sourceKind === "channel" ? "group" : "direct",
      id: params.sourceId,
    },
    dmScope: "per-account-channel-peer",
    identityLinks: params.identityLinks,
  });
}
