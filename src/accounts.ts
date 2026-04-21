import type { LineWorksConfig, ResolvedLineWorksAccount } from "./types.js";

export const DEFAULT_ACCOUNT_ID = "default";

export function listLineWorksAccountIds(config: LineWorksConfig | undefined): string[] {
  if (!config) return [];
  const ids = new Set<string>();
  if (config.clientId || config.botId) ids.add(DEFAULT_ACCOUNT_ID);
  for (const id of Object.keys(config.accounts ?? {})) ids.add(id);
  return [...ids];
}

export function resolveDefaultLineWorksAccountId(
  config: LineWorksConfig | undefined,
): string | undefined {
  if (!config) return undefined;
  if (config.defaultAccount) return config.defaultAccount;
  const ids = listLineWorksAccountIds(config);
  return ids[0];
}

export function resolveLineWorksAccount(args: {
  config: LineWorksConfig | undefined;
  accountId?: string;
}): ResolvedLineWorksAccount | undefined {
  const { config, accountId = DEFAULT_ACCOUNT_ID } = args;
  if (!config) return undefined;
  const sub = accountId === DEFAULT_ACCOUNT_ID ? config : config.accounts?.[accountId];
  if (!sub) return undefined;

  const clientId = sub.clientId ?? config.clientId;
  const clientSecret = sub.clientSecret ?? config.clientSecret;
  const serviceAccount = sub.serviceAccount ?? config.serviceAccount;
  const privateKey = sub.privateKey ?? config.privateKey;
  const botId = sub.botId ?? config.botId;
  const botSecret = sub.botSecret ?? config.botSecret;

  if (!clientId || !clientSecret || !serviceAccount || !privateKey || !botId || !botSecret) {
    return undefined;
  }

  return {
    accountId,
    name: sub.name ?? config.name,
    enabled: sub.enabled ?? config.enabled ?? true,
    clientId,
    clientSecret,
    serviceAccount,
    privateKey,
    botId,
    botSecret,
    domainId: sub.domainId ?? config.domainId,
    config: { ...config, ...sub },
  };
}
