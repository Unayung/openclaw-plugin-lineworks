import type { ResolvedLineWorksAccount } from "./types.js";

const CHANNEL_ID = "lineworks";

export type LineWorksInboundMessage = {
  body: string;
  from: string;
  senderName: string;
  conversationId: string;
  chatType: "direct" | "group";

  accountId: string;
  commandAuthorized: boolean;
};

export function buildLineWorksInboundContext<TContext>(params: {
  finalizeInboundContext: (ctx: Record<string, unknown>) => TContext;
  account: ResolvedLineWorksAccount;
  msg: LineWorksInboundMessage;
  sessionKey: string;
}): TContext {
  const { account, msg, sessionKey } = params;
  const conversationRef = `${CHANNEL_ID}:${msg.conversationId}`;
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
  });
}
