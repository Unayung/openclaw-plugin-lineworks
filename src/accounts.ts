import {
  DEFAULT_ACCOUNT_ID,
  listCombinedAccountIds,
  resolveMergedAccountConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import type {
  LineWorksAccountConfig,
  LineWorksConfig,
  LineWorksDmPolicy,
  LineWorksGroupPolicy,
  ResolvedLineWorksAccount,
} from "./types.js";

export { DEFAULT_ACCOUNT_ID };

const CHANNEL_ID = "lineworks" as const;
const DEFAULT_WEBHOOK_PATH = "/lineworks/webhook";

function getChannelConfig(cfg: OpenClawConfig): LineWorksConfig | undefined {
  return cfg?.channels?.[CHANNEL_ID] as LineWorksConfig | undefined;
}

function resolveImplicitAccountId(channelCfg: LineWorksConfig): string | undefined {
  const hasTopLevel =
    channelCfg.clientId ||
    channelCfg.botId ||
    process.env.LINEWORKS_CLIENT_ID ||
    process.env.LINEWORKS_BOT_ID;
  return hasTopLevel ? DEFAULT_ACCOUNT_ID : undefined;
}

function normalizeAllowFrom(raw: Array<string | number> | undefined): string[] {
  if (!raw) return [];
  return raw
    .map((entry) => String(entry).trim())
    .filter(Boolean);
}

function envOr(value: string | undefined, envKey: string): string {
  if (value && value.trim()) return value.trim();
  const env = process.env[envKey];
  if (!env) return "";
  if (envKey === "LINEWORKS_PRIVATE_KEY") {
    return env.replace(/\\n/g, "\n");
  }
  return env.trim();
}

export function listLineWorksAccountIds(cfg: OpenClawConfig): string[] {
  const channelCfg = getChannelConfig(cfg);
  if (!channelCfg) return [];
  return listCombinedAccountIds({
    configuredAccountIds: Object.keys(channelCfg.accounts ?? {}),
    implicitAccountId: resolveImplicitAccountId(channelCfg),
  });
}

export function resolveLineWorksAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedLineWorksAccount {
  const channelCfg = getChannelConfig(cfg) ?? {};
  const id = accountId || DEFAULT_ACCOUNT_ID;
  const merged = resolveMergedAccountConfig<
    Record<string, unknown> & LineWorksAccountConfig
  >({
    channelConfig: channelCfg as Record<string, unknown> & LineWorksConfig,
    accounts: channelCfg.accounts as
      | Record<string, Partial<Record<string, unknown> & LineWorksAccountConfig>>
      | undefined,
    accountId: id,
  });

  const dmPolicy: LineWorksDmPolicy = (merged.dmPolicy ?? "pairing") as LineWorksDmPolicy;
  const groupPolicy: LineWorksGroupPolicy =
    (merged.groupPolicy ?? "allowlist") as LineWorksGroupPolicy;

  return {
    accountId: id,
    name: merged.name,
    enabled: merged.enabled ?? true,
    clientId: envOr(merged.clientId, "LINEWORKS_CLIENT_ID"),
    clientSecret: envOr(merged.clientSecret, "LINEWORKS_CLIENT_SECRET"),
    serviceAccount: envOr(merged.serviceAccount, "LINEWORKS_SERVICE_ACCOUNT"),
    privateKey: envOr(merged.privateKey, "LINEWORKS_PRIVATE_KEY"),
    botId: envOr(merged.botId, "LINEWORKS_BOT_ID"),
    botSecret: envOr(merged.botSecret, "LINEWORKS_BOT_SECRET"),
    domainId: envOr(merged.domainId, "LINEWORKS_DOMAIN_ID") || undefined,
    webhookPath: merged.webhookPath?.trim() || DEFAULT_WEBHOOK_PATH,
    dmPolicy,
    groupPolicy,
    allowFrom: normalizeAllowFrom(merged.allowFrom),
    groupAllowFrom: normalizeAllowFrom(merged.groupAllowFrom),
    config: { ...channelCfg, ...merged },
  };
}

export function resolveDefaultLineWorksAccountId(
  cfg: OpenClawConfig,
): string | undefined {
  const channelCfg = getChannelConfig(cfg);
  if (!channelCfg) return undefined;
  if (channelCfg.defaultAccount) return channelCfg.defaultAccount;
  return listLineWorksAccountIds(cfg)[0];
}

export function hasLineWorksCredentials(account: ResolvedLineWorksAccount): boolean {
  return Boolean(
    account.clientId &&
      account.clientSecret &&
      account.serviceAccount &&
      account.privateKey &&
      account.botId &&
      account.botSecret,
  );
}
