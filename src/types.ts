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
  /**
   * Extra OAuth scopes to request when minting the bot's service-account
   * access token, on top of the baseline `bot bot.read user.profile.read`.
   * Populate with the scopes you've granted admin consent for in Developer
   * Console — e.g. `["mail", "mail.read"]` to enable mail send, or
   * `["calendar.read"]` for free/busy lookups. Silently ignored by LINE
   * WORKS if the app doesn't actually have the scope granted.
   */
  extraScopes?: string[];
  /**
   * Enrich inbound context with the sender's profile (email, display name,
   * department) via the Directory API. Requires `user.profile.read` or
   * `user.email.read` scope on the app. Defaults to true.
   */
  senderProfileEnrichment?: boolean;
  /**
   * When true and the inbound message matches a mail-check intent (e.g.
   * "查看我的信箱", "check my mail"), pre-fetch the sender's recent mail via
   * `listRecentMail` and inject it into the agent context as `RecentMail`
   * so the model can summarize without needing a tool loop.
   *
   * Requires `mail.read` scope (add to `extraScopes`) AND
   * `senderProfileEnrichment` (to know whose mailbox to read). Defaults to
   * false — opt-in because it silently hits the Mail API on every message.
   */
  mailPreFetch?: {
    /** Turn the feature on. Default false. */
    enabled?: boolean;
    /** How many recent mails to pull. Default 10. Cap 50. */
    count?: number;
  };
  /**
   * Public HTTPS base URL at which this gateway is reachable from the
   * internet. Required when `oauth.enabled=true` so the plugin can build
   * redirect URIs LINE WORKS will accept. For ngrok setups, this rotates
   * when ngrok restarts — keep it in sync with Developer Console →
   * App → Redirect URIs.
   *
   * Example: "https://racco-bot.ngrok.app"
   */
  publicBaseUrl?: string;
  /**
   * Per-user OAuth 2.0 flow settings. Needed for API scopes that LINE WORKS
   * refuses to grant to service-account tokens (mail, task, file, form,
   * group.folder, group.note). When disabled, those features fall back to
   * "grant link" prompts.
   */
  oauth?: {
    /** Turn OAuth features on. Default false. */
    enabled?: boolean;
    /**
     * Path for the start endpoint (user-facing link destination). Default
     * `/oauth/lineworks/start`.
     */
    startPath?: string;
    /**
     * Path for the callback endpoint (registered in Developer Console →
     * Redirect URIs). Default `/oauth/lineworks/callback`.
     */
    callbackPath?: string;
    /**
     * Comma-separated OAuth scopes to request at the consent screen.
     * Default covers all known user-scoped features:
     * `mail,mail.read,task,task.read,file,file.read,calendar,calendar.read,user.profile.read,user.email.read`
     */
    scopes?: string;
  };
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
  extraScopes: string[];
  senderProfileEnrichment: boolean;
  mailPreFetchEnabled: boolean;
  mailPreFetchCount: number;
  publicBaseUrl: string | undefined;
  oauthEnabled: boolean;
  oauthStartPath: string;
  oauthCallbackPath: string;
  oauthScopes: string;
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
  /** Unused — LINE WORKS audio spec doesn't accept a `duration` field.
   * Kept optional in the type for back-compat but not emitted. */
  duration?: number;
}
export interface LineWorksOutboundAudioFileMessage {
  type: "audio";
  fileId: string;
  duration?: number;
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
