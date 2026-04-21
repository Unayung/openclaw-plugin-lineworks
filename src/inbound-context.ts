import { buildAgentMediaPayload } from "openclaw/plugin-sdk/agent-media-payload";
import type { ResolvedLineWorksAccount } from "./types.js";

const CHANNEL_ID = "lineworks";

export type LineWorksInboundMedia = {
  path: string;
  contentType: string;
};

export type LineWorksInboundMessage = {
  body: string;
  from: string;
  senderName: string;
  conversationId: string;
  chatType: "direct" | "group";
  accountId: string;
  commandAuthorized: boolean;
  /** Already-downloaded media paths to attach to the agent context. */
  media?: LineWorksInboundMedia[];
  /** Raw attachment resourceIds to download before dispatch. */
  attachmentResourceIds?: string[];
};

export function buildLineWorksInboundContext<TContext>(params: {
  finalizeInboundContext: (ctx: Record<string, unknown>) => TContext;
  account: ResolvedLineWorksAccount;
  msg: LineWorksInboundMessage;
  sessionKey: string;
}): TContext {
  const { account, msg, sessionKey } = params;
  const conversationRef = `${CHANNEL_ID}:${msg.conversationId}`;
  const mediaPayload = msg.media?.length
    ? buildAgentMediaPayload(msg.media.map((m) => ({ path: m.path, contentType: m.contentType })))
    : {};
  return params.finalizeInboundContext({
    Body: msg.body,
    RawBody: msg.body,
    CommandBody: msg.body,
    From: `${CHANNEL_ID}:${msg.from}`,
    To: conversationRef,
    SessionKey: sessionKey,
    AccountId: account.accountId,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: conversationRef,
    ChatType: msg.chatType,
    SenderName: msg.senderName,
    SenderId: msg.from,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    ConversationLabel: msg.senderName || msg.from,
    Timestamp: Date.now(),
    CommandAuthorized: msg.commandAuthorized,
    ...mediaPayload,
  });
}
