import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import {
  createHybridChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  createChatChannelPlugin,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-lifecycle";
import { createConditionalWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import { attachChannelToResult } from "openclaw/plugin-sdk/channel-send-result";
import { createEmptyChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import {
  hasLineWorksCredentials,
  listLineWorksAccountIds,
  resolveLineWorksAccount,
} from "./accounts.js";
import { LineWorksChannelConfigSchema } from "./config-schema.js";
import {
  registerLineWorksWebhookRoute,
  validateLineWorksStartup,
} from "./gateway-runtime.js";
import { sendMessage, sendText } from "./send.js";
import { lineWorksSetupAdapter, lineWorksSetupWizard } from "./setup-surface.js";
import type { ResolvedLineWorksAccount } from "./types.js";

export const LINEWORKS_CHANNEL_ID = "lineworks" as const;

type LineWorksGatewayContext = {
  cfg: OpenClawConfig;
  accountId: string;
  abortSignal: AbortSignal;
  log?: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
};

type LineWorksSendContext = {
  cfg: OpenClawConfig;
  to: string;
  text?: string;
  mediaUrl?: string;
  accountId?: string | null;
};
type LineWorksSendTextContext = LineWorksSendContext & { text: string };
type LineWorksSendMediaContext = LineWorksSendContext & { mediaUrl: string };

type LineWorksOutboundResult = {
  channel: typeof LINEWORKS_CHANNEL_ID;
  messageId: string;
  chatId: string;
};

type LineWorksPlugin = Omit<
  ChannelPlugin<ResolvedLineWorksAccount>,
  "pairing" | "security" | "messaging" | "directory" | "outbound" | "gateway" | "agentPrompt"
> & {
  pairing: {
    idLabel: string;
    notifyApproval: (params: { cfg: OpenClawConfig; id: string }) => Promise<void>;
  };
  security: {
    resolveDmPolicy: (params: {
      cfg: OpenClawConfig;
      account: ResolvedLineWorksAccount;
    }) => {
      policy: string | null | undefined;
      allowFrom?: Array<string | number>;
    } | null;
    collectWarnings: (params: {
      cfg: OpenClawConfig;
      account: ResolvedLineWorksAccount;
    }) => string[];
  };
  messaging: {
    normalizeTarget: (target: string) => string | undefined;
    targetResolver: {
      looksLikeId: (id: string) => boolean;
      hint: string;
    };
  };
  directory: {
    self?: NonNullable<ChannelPlugin<ResolvedLineWorksAccount>["directory"]>["self"];
    listPeers?: NonNullable<ChannelPlugin<ResolvedLineWorksAccount>["directory"]>["listPeers"];
    listGroups?: NonNullable<ChannelPlugin<ResolvedLineWorksAccount>["directory"]>["listGroups"];
  };
  outbound: {
    deliveryMode: "gateway";
    textChunkLimit: number;
    sendText: (ctx: LineWorksSendTextContext) => Promise<LineWorksOutboundResult>;
    sendMedia: (ctx: LineWorksSendMediaContext) => Promise<LineWorksOutboundResult>;
  };
  gateway: {
    startAccount: (ctx: LineWorksGatewayContext) => Promise<unknown>;
    stopAccount: (ctx: LineWorksGatewayContext) => Promise<void>;
  };
  agentPrompt: {
    messageToolHints: () => string[];
  };
};

const resolveLineWorksDmPolicy =
  createScopedDmSecurityResolver<ResolvedLineWorksAccount>({
    channelKey: LINEWORKS_CHANNEL_ID,
    resolvePolicy: (account) => account.dmPolicy,
    resolveAllowFrom: (account) => account.allowFrom,
    policyPathSuffix: "dmPolicy",
    defaultPolicy: "pairing",
    approveHint: "openclaw pairing approve lineworks <code>",
  });

const lineWorksConfigAdapter = createHybridChannelConfigAdapter<ResolvedLineWorksAccount>({
  sectionKey: LINEWORKS_CHANNEL_ID,
  listAccountIds: listLineWorksAccountIds,
  resolveAccount: resolveLineWorksAccount,
  defaultAccountId: () => DEFAULT_ACCOUNT_ID,
  clearBaseFields: [
    "clientId",
    "clientSecret",
    "serviceAccount",
    "privateKey",
    "privateKeyFile",
    "botId",
    "botSecret",
    "domainId",
    "webhookPath",
    "dmPolicy",
    "groupPolicy",
    "allowFrom",
    "groupAllowFrom",
  ],
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: (allowFrom) => allowFrom.map((x) => String(x).trim()).filter(Boolean),
});

const collectLineWorksSecurityWarnings =
  createConditionalWarningCollector<ResolvedLineWorksAccount>(
    (account) =>
      !hasLineWorksCredentials(account) &&
      "- LINE WORKS: credentials incomplete (need clientId/clientSecret/serviceAccount/privateKey/botId/botSecret).",
    (account) =>
      account.dmPolicy === "open" &&
      '- LINE WORKS: dmPolicy="open" allows any user to message the bot. Consider "pairing" or "allowlist" for production.',
    (account) =>
      account.dmPolicy === "allowlist" &&
      account.allowFrom.length === 0 &&
      '- LINE WORKS: dmPolicy="allowlist" with empty allowFrom blocks all senders.',
  );

function resolveSendContext(args: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
}): {
  account: ResolvedLineWorksAccount;
  target: { type: "user"; userId: string } | { type: "channel"; channelId: string };
} {
  const account = resolveLineWorksAccount(args.cfg ?? {}, args.accountId);
  if (!hasLineWorksCredentials(account)) {
    throw new Error("LINE WORKS: account is missing credentials");
  }
  const normalized = args.to
    .trim()
    .replace(/^lineworks:(user|channel):/i, (_m: string, kind: string) => `${kind}:`)
    .replace(/^lineworks:/i, "");
  const channelMatch = normalized.match(/^channel:(.+)$/i);
  const userMatch = normalized.match(/^user:(.+)$/i);
  const target =
    channelMatch && channelMatch[1]
      ? ({ type: "channel" as const, channelId: channelMatch[1] })
      : userMatch && userMatch[1]
        ? ({ type: "user" as const, userId: userMatch[1] })
        : ({ type: "user" as const, userId: normalized });
  return { account, target };
}

export function createLineWorksPlugin(): LineWorksPlugin {
  return createChatChannelPlugin({
    base: {
      id: LINEWORKS_CHANNEL_ID,
      meta: {
        id: LINEWORKS_CHANNEL_ID,
        label: "LINE WORKS",
        selectionLabel: "LINE WORKS (Works Mobile)",
        detailLabel: "LINE WORKS Bot",
        docsPath: "/channels/lineworks",
        blurb: "Connect a LINE WORKS bot to OpenClaw for enterprise messaging.",
        order: 76,
      },
      capabilities: {
        chatTypes: ["direct", "group"] as const,
        media: false,
        threads: false,
        reactions: false,
        edit: false,
        unsend: false,
        reply: false,
        effects: false,
        blockStreaming: true,
      },
      reload: { configPrefixes: [`channels.${LINEWORKS_CHANNEL_ID}`] },
      configSchema: LineWorksChannelConfigSchema,
      setup: lineWorksSetupAdapter,
      setupWizard: lineWorksSetupWizard,
      config: {
        ...lineWorksConfigAdapter,
      },
      messaging: {
        normalizeTarget: (target: string) => {
          const trimmed = target.trim();
          if (!trimmed) return undefined;
          return trimmed
            .replace(/^lineworks:(user|channel):/i, "")
            .replace(/^lineworks:/i, "")
            .trim();
        },
        targetResolver: {
          looksLikeId: (id: string) => {
            const trimmed = id?.trim();
            if (!trimmed) return false;
            return /^lineworks:/i.test(trimmed) || /^[\w-]{8,}$/.test(trimmed);
          },
          hint: "<userId|channelId>",
        },
      },
      directory: createEmptyChannelDirectoryAdapter(),
      gateway: {
        startAccount: async (ctx: LineWorksGatewayContext) => {
          const { cfg, accountId, log, abortSignal } = ctx;
          const account = resolveLineWorksAccount(cfg, accountId);
          if (!validateLineWorksStartup({ cfg, account, accountId, log }).ok) {
            return waitUntilAbort(abortSignal);
          }
          log?.info?.(
            `Starting LINE WORKS channel (account: ${accountId}, path: ${account.webhookPath})`,
          );
          const unregister = registerLineWorksWebhookRoute({ account, accountId, log });
          log?.info?.(`Registered HTTP route: ${account.webhookPath} for LINE WORKS`);
          return waitUntilAbort(abortSignal, () => {
            log?.info?.(`Stopping LINE WORKS channel (account: ${accountId})`);
            unregister();
          });
        },
        stopAccount: async (ctx: LineWorksGatewayContext) => {
          ctx.log?.info?.(`LINE WORKS account ${ctx.accountId} stopped`);
        },
      },
      agentPrompt: {
        messageToolHints: () => [
          "",
          "### LINE WORKS Formatting",
          "LINE WORKS supports plain text + inline images + file attachments.",
          "",
          "**Text replies**:",
          "- Keep text responses conversational and under ~1500 characters.",
          "- Messages over 2000 chars are auto-split on newline boundaries.",
          "- Do **not** dump long documents, full code listings, or generated",
          "  markdown inline — mobile LINE WORKS UI collapses long messages badly.",
          "",
          "**Send as a file, not inline text** (use `mediaUrl` in the reply payload):",
          "- Any generated markdown, code, spreadsheet, log, or structured doc",
          "  that is > ~800 chars or spans > ~20 lines.",
          "- Reports, transcripts, READMEs, configs, diffs, CSVs, logs — always files.",
          "- Save the content to the workspace with an appropriate extension",
          "  (`.md`, `.txt`, `.json`, `.py`, `.csv`, `.pdf`, …) and return the",
          "  filesystem path as `mediaUrl`. The plugin uploads it to LINE WORKS",
          "  and the recipient sees a downloadable file attachment.",
          "- For multiple files, use `mediaUrls: [path1, path2, …]`.",
          "",
          "**Send as an inline image**:",
          "- If `mediaUrl` points at an `.jpg|.jpeg|.png|.gif|.webp|.heic` file",
          "  (or an `https://` image URL), it renders inline.",
          "- For screenshots, generated visuals, photos — always use mediaUrl.",
          "",
          "**Combining**:",
          "- `{ text: 'brief caption', mediaUrl: '/path/to/image.png' }` — image + short caption.",
          "- `{ text: 'here is the report', mediaUrl: '/path/to/report.md' }` — file + pointer text.",
          "- Media is sent first, then the text, as separate messages.",
          "",
          "**Rich cards (Flex messages)**:",
          "- For product listings, quotes, receipts, menu cards, buttons, or any",
          "  layout that text can't convey — emit a Flex directive in your reply text:",
          "",
          "    [[flex: <altText> ||| <JSON contents>]]",
          "",
          "  The `|||` separates the notification/fallback alt text from the",
          "  Flex contents JSON. The JSON is LINE Flex format (identical to",
          "  LINE consumer Flex — a `bubble` or `carousel`).",
          "",
          "  Example — a simple info card:",
          "",
          '    [[flex: Welcome card ||| {"type":"bubble","body":{"type":"box",',
          '    "layout":"vertical","contents":[{"type":"text","text":"Hello!",',
          '    \"weight\":\"bold\",\"size\":\"xl\"}]}}]]',
          "",
          "  Multiple `[[flex: … ||| …]]` directives in one reply are all sent.",
          "  Keep JSON on one logical line; your normal text before/after the",
          "  directive is sent as a separate text message (can be empty).",
          "",
          "**Limitations**:",
          "- Flex JSON must be valid and well-formed; parse failures are logged and dropped.",
          "- No video/audio reply media yet (planned).",
          "- Local file uploads have a ~15 MB cap.",
        ],
      },
    },
    pairing: {
      text: {
        idLabel: "lineWorksUserId",
        message: "OpenClaw: your access has been approved.",
        notify: async ({ cfg, id, message }) => {
          const account = resolveLineWorksAccount(cfg);
          if (!hasLineWorksCredentials(account)) return;
          try {
            await sendText({
              account,
              target: { type: "user", userId: id },
              text: message,
            });
          } catch {
            // best-effort notification; pairing proceeds regardless
          }
        },
      },
    },
    security: {
      resolveDmPolicy: resolveLineWorksDmPolicy,
      collectWarnings: ({
        account,
      }: {
        cfg: OpenClawConfig;
        account: ResolvedLineWorksAccount;
      }) => collectLineWorksSecurityWarnings(account),
    },
    outbound: {
      deliveryMode: "gateway" as const,
      textChunkLimit: 2000,
      sendText: async ({ to, text, accountId, cfg }: LineWorksSendTextContext) => {
        const { account, target } = resolveSendContext({ cfg, accountId, to });
        await sendText({ account, target, text });
        return attachChannelToResult(LINEWORKS_CHANNEL_ID, {
          messageId: `lw-${Date.now()}`,
          chatId: to,
        });
      },
      sendMedia: async ({ to, mediaUrl, accountId, cfg }: LineWorksSendContext) => {
        if (!mediaUrl) throw new Error("LINE WORKS: sendMedia requires mediaUrl");
        const { account, target } = resolveSendContext({ cfg, accountId, to });
        if (!/^https:\/\//i.test(mediaUrl)) {
          throw new Error(
            `LINE WORKS outbound.sendMedia requires https:// URL; got ${mediaUrl.slice(0, 80)}. Use the deliver path for local files (auto-uploads).`,
          );
        }
        await sendMessage({
          account,
          target,
          message: {
            type: "image",
            previewImageUrl: mediaUrl,
            originalContentUrl: mediaUrl,
          },
        });
        return attachChannelToResult(LINEWORKS_CHANNEL_ID, {
          messageId: `lw-${Date.now()}`,
          chatId: to,
        });
      },
    },
  }) as unknown as LineWorksPlugin;
}

export const lineWorksPlugin = createLineWorksPlugin();

export {
  getAccessToken,
  clearAccessTokenCache,
} from "./auth.js";
export {
  LINEWORKS_SIGNATURE_HEADER,
  LINEWORKS_BOT_ID_HEADER,
  verifySignature,
  parseInboundEvent,
} from "./webhook.js";
export { sendMessage, sendText } from "./send.js";
export {
  DEFAULT_ACCOUNT_ID,
  listLineWorksAccountIds,
  resolveDefaultLineWorksAccountId,
  resolveLineWorksAccount,
  hasLineWorksCredentials,
} from "./accounts.js";
export { LineWorksConfigSchema, LineWorksChannelConfigSchema } from "./config-schema.js";
