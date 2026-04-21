export type LineWorksDmPolicy = "open" | "allowlist" | "pairing" | "disabled";
export type LineWorksGroupPolicy = "open" | "allowlist" | "disabled";

export interface LineWorksThinkingAckConfig {
  /** Ms to wait before sending the ack. 0 disables. Default 5000. */
  delayMs?: number;
  /** Text of the ack message. Default "⋯". */
  text?: string;
}

interface LineWorksAccountBaseConfig {
  enabled?: boolean;
  clientId?: string;
  clientSecret?: string;
  serviceAccount?: string;
  privateKey?: string;
  privateKeyFile?: string;
  botId?: string;
  botSecret?: string;
  domainId?: string;
  name?: string;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  dmPolicy?: LineWorksDmPolicy;
  groupPolicy?: LineWorksGroupPolicy;
  webhookPath?: string;
  thinkingAck?: LineWorksThinkingAckConfig;
  /** When true, the bot only responds to group messages that @mention it. */
  groupRequireMention?: boolean;
  /**
   * The @handle users type to mention this bot (without the leading @).
   * Example: "Racco" matches text containing "@Racco". Case-insensitive.
   * When unset, any @-token in the text is treated as a likely mention
   * (the PoC default, noisy in busy groups).
   */
  botMentionHandle?: string;
}

export interface LineWorksConfig extends LineWorksAccountBaseConfig {
  accounts?: Record<string, LineWorksAccountConfig>;
  defaultAccount?: string;
}

export interface LineWorksAccountConfig extends LineWorksAccountBaseConfig {}

export interface LineWorksAccessToken {
  token: string;
  tokenType: "Bearer";
  expiresAt: number;
  scope?: string;
}

export interface ResolvedLineWorksAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  serviceAccount: string;
  privateKey: string;
  botId: string;
  botSecret: string;
  domainId?: string;
  webhookPath: string;
  dmPolicy: LineWorksDmPolicy;
  groupPolicy: LineWorksGroupPolicy;
  groupRequireMention: boolean;
  botMentionHandle: string | undefined;
  allowFrom: string[];
  groupAllowFrom: string[];
  config: LineWorksConfig & LineWorksAccountConfig;
}

export type LineWorksInboundKind =
  | "user-message"
  | "channel-message"
  | "bot-joined"
  | "bot-left"
  | "member-joined"
  | "member-left"
  | "postback"
  | "unknown";

export interface LineWorksInboundEvent {
  kind: LineWorksInboundKind;
  source: LineWorksInboundSource;
  content?: LineWorksInboundContent;
  raw: unknown;
  receivedAt: number;
}

export type LineWorksInboundSource =
  | { type: "user"; userId: string; domainId?: string }
  | { type: "channel"; channelId: string; userId?: string; domainId?: string };

export interface LineWorksMentionee {
  /** Account/user ID of the mentioned party, if extractable. */
  accountId?: string;
  /** Indices into the text where the @mention token starts and ends. */
  start?: number;
  end?: number;
}

export type LineWorksInboundContent =
  | { type: "text"; text: string; mentionees?: LineWorksMentionee[] }
  | { type: "image"; resourceId: string }
  | { type: "file"; resourceId: string; fileName?: string }
  | { type: "sticker"; packageId: string; stickerId: string }
  | { type: "location"; title?: string; latitude: number; longitude: number }
  | { type: "postback"; data: string };

export interface LineWorksOutboundTextMessage {
  type: "text";
  text: string;
}

export interface LineWorksOutboundImageUrlMessage {
  type: "image";
  previewImageUrl: string;
  originalContentUrl: string;
}

export interface LineWorksOutboundImageFileMessage {
  type: "image";
  fileId: string;
}

export type LineWorksOutboundImageMessage =
  | LineWorksOutboundImageUrlMessage
  | LineWorksOutboundImageFileMessage;

export interface LineWorksOutboundFileMessage {
  type: "file";
  fileId: string;
  fileName?: string;
}

/**
 * LINE WORKS Flex message. Structurally identical to LINE consumer Flex —
 * a bubble or carousel of bubbles with boxes, text, images, buttons, and URI
 * actions. `altText` is what shows on notifications + fallback clients.
 */
export interface LineWorksOutboundFlexMessage {
  type: "flex";
  altText: string;
  contents: Record<string, unknown>;
}

export interface LineWorksOutboundVideoUrlMessage {
  type: "video";
  originalContentUrl: string;
  previewImageUrl: string;
}
export interface LineWorksOutboundVideoFileMessage {
  type: "video";
  fileId: string;
}
export type LineWorksOutboundVideoMessage =
  | LineWorksOutboundVideoUrlMessage
  | LineWorksOutboundVideoFileMessage;

export interface LineWorksOutboundAudioUrlMessage {
  type: "audio";
  originalContentUrl: string;
  duration: number;
}
export interface LineWorksOutboundAudioFileMessage {
  type: "audio";
  fileId: string;
  duration: number;
}
export type LineWorksOutboundAudioMessage =
  | LineWorksOutboundAudioUrlMessage
  | LineWorksOutboundAudioFileMessage;

export interface LineWorksOutboundLocationMessage {
  type: "location";
  title: string;
  address: string;
  latitude: number;
  longitude: number;
}

/**
 * Quick reply attached to any message. Each item renders as a tappable chip
 * under the message; tapping sends the action back (as a new user message for
 * "message" type, as a postback for "postback", etc.).
 */
export type LineWorksQuickReplyAction =
  | { type: "message"; label: string; text: string }
  | { type: "uri"; label: string; uri: string }
  | { type: "postback"; label: string; data: string; displayText?: string }
  | { type: "camera"; label: string }
  | { type: "cameraRoll"; label: string }
  | { type: "location"; label: string };

export interface LineWorksQuickReplyItem {
  action: LineWorksQuickReplyAction;
  imageUrl?: string;
}

export interface LineWorksQuickReply {
  items: LineWorksQuickReplyItem[];
}

export type LineWorksOutboundMessage =
  | LineWorksOutboundTextMessage
  | LineWorksOutboundImageMessage
  | LineWorksOutboundFileMessage
  | LineWorksOutboundFlexMessage
  | LineWorksOutboundVideoMessage
  | LineWorksOutboundAudioMessage
  | LineWorksOutboundLocationMessage;

export type LineWorksTarget =
  | { type: "user"; userId: string }
  | { type: "channel"; channelId: string };
