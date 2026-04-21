import {
  createStandardChannelSetupStatus,
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  normalizeAccountId,
  type ChannelSetupAdapter,
  type ChannelSetupWizard,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import {
  hasLineWorksCredentials,
  listLineWorksAccountIds,
  resolveLineWorksAccount,
} from "./accounts.js";
import type { LineWorksAccountConfig, LineWorksConfig } from "./types.js";

const channel = "lineworks" as const;
const DEFAULT_WEBHOOK_PATH = "/lineworks/webhook";

const LINEWORKS_SETUP_HELP_LINES = [
  "1) Create a LINE WORKS Developer Console app (https://developers.worksmobile.com/console/)",
  "2) Issue a Service Account and download its RSA private key (PEM)",
  "3) Create a Bot under the app and copy its Bot ID + Bot Secret",
  "4) Enable the Bot Callback URL and set it to your gateway:",
  `   https://<gateway-host>${DEFAULT_WEBHOOK_PATH}`,
  "5) Grant the bot the needed scopes (bot, bot.read)",
  `Docs: ${formatDocsLink("/channels/lineworks", "channels/lineworks")}`,
];

function getChannelConfig(cfg: OpenClawConfig): LineWorksConfig {
  return (cfg.channels?.[channel] as LineWorksConfig | undefined) ?? {};
}

function getRawAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): LineWorksAccountConfig | LineWorksConfig {
  const channelCfg = getChannelConfig(cfg);
  if (accountId === DEFAULT_ACCOUNT_ID) return channelCfg;
  return channelCfg.accounts?.[accountId] ?? {};
}

function isConfigured(cfg: OpenClawConfig, accountId: string): boolean {
  return hasLineWorksCredentials(resolveLineWorksAccount(cfg, accountId));
}

function patchLineWorksAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  patch: Record<string, unknown>;
  clearFields?: string[];
  enabled?: boolean;
}): OpenClawConfig {
  const channelCfg = getChannelConfig(params.cfg);
  if (params.accountId === DEFAULT_ACCOUNT_ID) {
    const next = { ...channelCfg } as Record<string, unknown>;
    for (const f of params.clearFields ?? []) delete next[f];
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [channel]: {
          ...next,
          ...(params.enabled ? { enabled: true } : {}),
          ...params.patch,
        },
      },
    };
  }
  const nextAccounts = { ...(channelCfg.accounts ?? {}) } as Record<
    string,
    Record<string, unknown>
  >;
  const nextAcc = { ...(nextAccounts[params.accountId] ?? {}) };
  for (const f of params.clearFields ?? []) delete nextAcc[f];
  nextAccounts[params.accountId] = {
    ...nextAcc,
    ...(params.enabled ? { enabled: true } : {}),
    ...params.patch,
  };
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [channel]: {
        ...channelCfg,
        ...(params.enabled ? { enabled: true } : {}),
        accounts: nextAccounts,
      },
    },
  };
}

export const lineWorksSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId) ?? DEFAULT_ACCOUNT_ID,
  validateInput: ({ input }) => {
    if (!input.useEnv && !input.token?.trim()) {
      return "LINE WORKS requires --token (bot secret) or --use-env.";
    }
    return null;
  },
  applyAccountConfig: ({ cfg, accountId, input }) =>
    patchLineWorksAccountConfig({
      cfg,
      accountId,
      enabled: true,
      clearFields: input.useEnv ? ["botSecret"] : undefined,
      patch: input.useEnv ? {} : { botSecret: input.token?.trim() },
    }),
};

export const lineWorksSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "LINE WORKS",
    configuredLabel: "configured",
    unconfiguredLabel: "needs JWT credentials + bot secret",
    configuredHint: "configured",
    unconfiguredHint: "needs JWT credentials + bot secret",
    configuredScore: 1,
    unconfiguredScore: 0,
    includeStatusLine: true,
    resolveConfigured: ({ cfg, accountId }) =>
      accountId
        ? isConfigured(cfg, accountId)
        : listLineWorksAccountIds(cfg).some((id) => isConfigured(cfg, id)),
    resolveExtraStatusLines: ({ cfg }) => [`Accounts: ${listLineWorksAccountIds(cfg).length || 0}`],
  }),
  introNote: {
    title: "LINE WORKS bot setup",
    lines: LINEWORKS_SETUP_HELP_LINES,
  },
  credentials: [
    {
      inputKey: "token",
      providerHint: channel,
      credentialLabel: "bot secret",
      preferredEnvVar: "LINEWORKS_BOT_SECRET",
      helpTitle: "LINE WORKS bot secret (for webhook signature verification)",
      helpLines: LINEWORKS_SETUP_HELP_LINES,
      envPrompt: "LINEWORKS_BOT_SECRET detected. Use env var?",
      keepPrompt: "LINE WORKS bot secret already configured. Keep it?",
      inputPrompt: "Enter LINE WORKS bot secret",
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      inspect: ({ cfg, accountId }) => {
        const account = resolveLineWorksAccount(cfg, accountId);
        const raw = getRawAccountConfig(cfg, accountId);
        return {
          accountConfigured: isConfigured(cfg, accountId),
          hasConfiguredValue: Boolean(raw.botSecret?.trim()),
          resolvedValue: account.botSecret || undefined,
          envValue:
            accountId === DEFAULT_ACCOUNT_ID
              ? process.env.LINEWORKS_BOT_SECRET?.trim() || undefined
              : undefined,
        };
      },
      applyUseEnv: async ({ cfg, accountId }) =>
        patchLineWorksAccountConfig({
          cfg,
          accountId,
          enabled: true,
          clearFields: ["botSecret"],
          patch: {},
        }),
      applySet: async ({ cfg, accountId, resolvedValue }) =>
        patchLineWorksAccountConfig({
          cfg,
          accountId,
          enabled: true,
          patch: { botSecret: resolvedValue },
        }),
    },
  ],
};
