import { z } from "openclaw/plugin-sdk/zod";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";

const DmPolicySchema = z.enum(["open", "allowlist", "pairing", "disabled"]);
const GroupPolicySchema = z.enum(["open", "allowlist", "disabled"]);

const ThinkingAckSchema = z
  .object({
    delayMs: z.number().int().min(0).optional(),
    text: z.string().optional(),
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
});

const LineWorksAccountConfigSchema = LineWorksCommonConfigSchema.strict();

export const LineWorksConfigSchema = LineWorksCommonConfigSchema.extend({
  accounts: z.record(z.string(), LineWorksAccountConfigSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).strict();

export const LineWorksChannelConfigSchema = buildChannelConfigSchema(LineWorksConfigSchema);

export type LineWorksConfigSchemaType = z.infer<typeof LineWorksConfigSchema>;
