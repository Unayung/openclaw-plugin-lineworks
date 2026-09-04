import { z } from "zod";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";

const DmPolicySchema = z.enum(["open", "allowlist", "pairing", "disabled"]);
const GroupPolicySchema = z.enum(["open", "allowlist", "disabled"]);

const ThinkingAckSchema = z
  .object({
    delayMs: z.number().int().min(0).optional(),
    // Plain text, or "sticker:<packageId>:<stickerId>" to ack with a sticker.
    text: z.string().optional(),
  })
  .strict();

const LineWorksChannelEntrySchema = z
  .object({
    enabled: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    users: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .strict();

const LineWorksCommonConfigSchema = z.object({
  enabled: z.boolean().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  serviceAccount: z.string().optional(),
  privateKey: z.string().optional(),
  privateKeyFile: z.string().optional(),
  botId: z.string().optional(),
  botSecret: z.string().optional(),
  domainId: z.string().optional(),
  name: z.string().optional(),
  allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  dmPolicy: DmPolicySchema.optional().default("pairing"),
  groupPolicy: GroupPolicySchema.optional().default("allowlist"),
  webhookPath: z.string().optional(),
  thinkingAck: ThinkingAckSchema.optional(),
  groupRequireMention: z.boolean().optional().default(false),
  /**
   * Alias for `groupRequireMention`, matching the Slack plugin's account-level
   * field name. When both are set, this takes precedence. Per-channel entries
   * in `channels` may override on a per-channel basis.
   */
  requireMention: z.boolean().optional(),
  /**
   * Per-channel (group) settings keyed by LINE WORKS channelId. Mirrors the
   * Slack plugin's `channels` map: when populated and `groupPolicy` is
   * `allowlist`, only listed channels (or the `*` wildcard fallback) are
   * accepted. Each entry may override `requireMention` and restrict which
   * senders (`users`) may trigger the bot in that channel.
   */
  channels: z.record(z.string(), LineWorksChannelEntrySchema.optional()).optional(),
  botMentionHandle: z.string().optional(),
  extraScopes: z.array(z.string()).optional(),
  senderProfileEnrichment: z.boolean().optional().default(true),
  mailPreFetch: z
    .object({
      enabled: z.boolean().optional(),
      count: z.number().int().min(1).max(50).optional(),
    })
    .strict()
    .optional(),
  publicBaseUrl: z.string().url().optional(),
  oauth: z
    .object({
      enabled: z.boolean().optional(),
      startPath: z.string().optional(),
      callbackPath: z.string().optional(),
      scopes: z.string().optional(),
    })
    .strict()
    .optional(),
});

const LineWorksAccountConfigSchema = LineWorksCommonConfigSchema.strict();

export const LineWorksConfigSchema = LineWorksCommonConfigSchema.extend({
  accounts: z.record(z.string(), LineWorksAccountConfigSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).strict();

export const LineWorksChannelConfigSchema = buildChannelConfigSchema(LineWorksConfigSchema);

export type LineWorksConfigSchemaType = z.infer<typeof LineWorksConfigSchema>;
