export type LineWorksDmPolicy = "open" | "allowlist" | "pairing" | "disabled";
export type LineWorksGroupPolicy = "open" | "allowlist" | "disabled";

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

export type LineWorksInboundContent =
  | { type: "text"; text: string }
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

export type LineWorksOutboundMessage =
  | LineWorksOutboundTextMessage
  | LineWorksOutboundImageMessage
  | LineWorksOutboundFileMessage;

export type LineWorksTarget =
  | { type: "user"; userId: string }
  | { type: "channel"; channelId: string };
