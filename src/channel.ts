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
import {
  downloadHttpsToTempFile,
  mediaKindForContentType,
  uploadLineWorksAttachment,
} from "./attachments.js";
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
        // Strip ONLY the `lineworks:` channel prefix. Preserve the
        // `user:`/`channel:` discriminator so resolveSendContext in the
        // outbound path can route to the correct endpoint.
        normalizeTarget: (target: string) => {
          const trimmed = target.trim();
          if (!trimmed) return undefined;
          return trimmed.replace(/^lineworks:/i, "").trim();
        },
        targetResolver: {
          looksLikeId: (id: string) => {
            const trimmed = id?.trim();
            if (!trimmed) return false;
            return /^lineworks:/i.test(trimmed) || /^(user|channel):/i.test(trimmed) || /^[\w-]{8,}$/.test(trimmed);
          },
          hint: "user:<userId> | channel:<channelId>",
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
          "### LINE WORKS access — how to fetch user data directly",
          "The `mail`, `task`, `file`, `form`, `group.folder`, `group.note`",
          "scopes require a PER-USER OAuth token — service-account tokens",
          "are rejected with 403 'Not allowed api'. When the user grants",
          "OAuth, the plugin stores their access + refresh token at:",
          "",
          "  ~/.openclaw/credentials/lineworks-oauth/<accountId>/<userId>.json",
          "",
          "The token JSON has `accessToken`, `refreshToken`, `expiresAt`,",
          "`scope`. To use it, call the LINE WORKS API directly via exec:",
          "",
          "  TOKEN=$(jq -r .accessToken ~/.openclaw/credentials/lineworks-oauth/default/$SENDER_ID.json)",
          "  curl -s -H \"Authorization: Bearer $TOKEN\" \\",
          "    \"https://www.worksapis.com/v1.0/users/$SENDER_EMAIL/mail/mailfolders/0/children?count=10&searchFilterType=all\"",
          "",
          "The sender's LINE WORKS userId is the last segment of `From`",
          "(format: `lineworks:user:<uuid>`). To resolve the email, you",
          "can call the Directory API with the bot's service-account token",
          "(the plugin uses that itself for `resolved sender` logs) — or",
          "look it up from `~/.openclaw/credentials/lineworks-oauth/default/<uuid>.json`",
          "where the plugin records the email after consent.",
          "",
          "Full runbook with curl examples for mail, calendar, task, drive:",
          "",
          "  ~/.openclaw/workspace-racco/LINEWORKS_API.md",
          "",
          "Read that file ONCE per session to learn the endpoints, then",
          "answer user questions via exec + curl. Token refresh (when",
          "`expiresAt` has passed) uses POST to",
          "`https://auth.worksmobile.com/oauth2/v2.0/token` with",
          "`grant_type=refresh_token`; see runbook for the full flow.",
          "",
          "**If the user asks for something requiring OAuth but no token",
          "file exists for their userId yet**, they need to grant first.",
          "Tell them and include the grant link (no helper exists to get",
          "it from the plugin at runtime — the link shape is:",
          "`{publicBaseUrl}/oauth/lineworks/start?user=<their-uuid>` but",
          "you typically won't know publicBaseUrl; just say 'I need",
          "LINE WORKS OAuth access, please run the grant flow' and the",
          "user can trigger it themselves).",
          "",
          "**Response budget**: fetching mail + summarizing should be 2–3",
          "exec calls max. Don't grep the plugin source, don't read",
          "openclaw core — the runbook above is everything you need.",
          "",
          "### LINE WORKS Flex URI safety",
          "Every `uri` action inside a Flex message (footer buttons, body",
          "taps, hero action) MUST be an absolute `https://…` URL. LINE WORKS",
          "rejects the whole Flex card with 400 INVALID_PARAMETER if any URI",
          "is empty, a relative path, a placeholder like `https://example.com`,",
          "or a non-HTTPS scheme (`http://`, `tel:`, `mailto:`). When you",
          "don't have a real URL, omit the button entirely — do NOT include a",
          "fake one.",
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
          "**Rich cards (Flex)** — `[[flex: <altText> ||| <JSON>]]`",
          "  Use for product lists, receipts, menus, detailed cards, carousels.",
          "  JSON is LINE Flex format (bubble or carousel). `|||` is the separator.",
          "  Multiple flex directives in one reply all get sent.",
          "",
          "  Example:",
          '    [[flex: Order #1234 ||| {"type":"bubble","body":{"type":"box",',
          '    "layout":"vertical","contents":[{"type":"text","text":"Order #1234",',
          '    "weight":"bold"}]}}]]',
          "",
          "**Location** — `[[location: <title> | <address> | <lat> | <lng>]]`",
          "  Pinned map location. Example:",
          "    [[location: Taipei 101 | No. 7, Xinyi Rd | 25.0330 | 121.5654]]",
          "",
          "**Quick-reply buttons** — `[[quick_replies: label1, label2, label3]]`",
          "  Tap-chips under the previous message; tapping sends the label as a",
          "  new user message. Up to 13 labels. Label variants:",
          "    - `Label`             → sends \"Label\" as user reply",
          "    - `Label > text`      → sends custom text as user reply",
          "    - `Label > https://…` → opens the URL",
          "    - `Label > data:foo`  → returns a postback event with `data=foo`",
          "",
          "  Example:",
          "    pick one: [[quick_replies: Yes, No, Maybe, Open > https://help.example]]",
          "",
          "**Outbound media (image/video/audio/file)**:",
          "- Emit `mediaUrl` in the reply payload pointing at either:",
          "    - An `https://` URL (LINE WORKS fetches it directly)",
          "    - A local workspace file path (plugin auto-uploads it)",
          "- The file extension drives the message type:",
          "    - image: .jpg .jpeg .png .gif .webp .heic",
          "    - video: .mp4 .mov .m4v .avi .webm",
          "    - audio: .mp3 .m4a .wav .aac .ogg",
          "    - anything else → file attachment (e.g. .md .pdf .csv .txt)",
          "- Long documents: save to workspace and emit as mediaUrl — do NOT",
          "  dump multi-page content inline.",
          "- Multiple media: `mediaUrls: [path1, path2, …]`",
          "",
          "**Combining**:",
          '  { text: "here", mediaUrl: "/path/to/photo.png" }  → photo + caption',
          '  { text: "pick one [[quick_replies: A, B]]" }       → text + chips',
          '  { text: "[[flex: card ||| {…}]]\\n\\n[[quick_replies: Buy, Cancel]]" }',
          "",
          "**Limitations**:",
          "- Video over HTTPS URL must come with a preview thumbnail; use an",
          "  uploaded video file instead if you don't have one.",
          "- Audio duration defaults to ~10s if unspecified.",
          "- Local file uploads cap at ~15 MB.",
          "- Flex JSON must be valid; parse failures are logged and dropped.",
          "",
          "### Mail send (optional)",
          "When the channel account has been granted the `mail` scope AND",
          "`SenderEmail` is present in context, you can send mail on behalf",
          "of the current user with a directive:",
          "",
          "    [[mail_send:",
          "    to: alice@example.com, bob@example.com",
          "    cc: carol@example.com",
          "    subject: Follow-up from our chat",
          "    body:",
          "    Hi Alice,",
          "    Here is the summary we talked about.",
          "    ]]",
          "",
          "- `to:` is required and may list multiple addresses (comma-separated).",
          "- `cc:` / `bcc:` are optional.",
          "- `subject:` is required.",
          "- `body:` is the last field; every line after it and before `]]`",
          "  is the mail body (multi-line is fine).",
          "- The mail is sent FROM `SenderEmail`, i.e. as the person chatting",
          "  with you — so only use this when the user has explicitly asked",
          "  you to send something on their behalf.",
          "- On success you'll see a `✉︎ sent to …` confirmation appended to",
          "  your reply; on failure you'll see `✉︎ mail send failed: …`.",
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

        // Kind from URL / local path extension. Extension-less URLs
        // (e.g. https://picsum.photos/id/237/400/300) land on "file" here
        // and we correct below using the actual Content-Type after download.
        const pathForExt = /^https?:\/\//i.test(mediaUrl)
          ? (new URL(mediaUrl).pathname || "")
          : mediaUrl.replace(/^file:\/\//, "");
        const ext = pathForExt.toLowerCase().split(".").pop() ?? "";
        const extKind: "image" | "video" | "audio" | "file" =
          ["jpg", "jpeg", "png", "gif", "webp", "heic"].includes(ext)
            ? "image"
            : ["mp4", "mov", "m4v", "avi", "webm"].includes(ext)
              ? "video"
              : ["mp3", "m4a", "wav", "aac", "ogg", "oga"].includes(ext)
                ? "audio"
                : "file";

        // HTTPS image with a recognized image extension: send URL directly
        // (LINE WORKS fetches). Everything else — video, audio, file,
        // extension-less URL, or non-TLS http:// — gets downloaded + uploaded.
        if (extKind === "image" && /^https:\/\//i.test(mediaUrl)) {
          await sendMessage({
            account,
            target,
            message: {
              type: "image",
              previewImageUrl: mediaUrl,
              originalContentUrl: mediaUrl,
            },
          });
        } else {
          let filePath: string;
          let fileName: string | undefined;
          let kind = extKind;
          if (/^https?:\/\//i.test(mediaUrl)) {
            const dl = await downloadHttpsToTempFile(mediaUrl);
            filePath = dl.path;
            fileName = dl.fileName;
            // Prefer the server's Content-Type when the URL path gave us no
            // useful extension — this rescues picsum-style image URLs.
            if (kind === "file") kind = mediaKindForContentType(dl.contentType);
          } else {
            filePath = mediaUrl.replace(/^file:\/\//, "");
          }
          const uploaded = await uploadLineWorksAttachment({ account, filePath, fileName });
          const message =
            kind === "image"
              ? ({ type: "image" as const, fileId: uploaded.fileId })
              : kind === "video"
                ? ({ type: "video" as const, fileId: uploaded.fileId })
                : kind === "audio"
                  ? ({ type: "audio" as const, fileId: uploaded.fileId })
                  : ({
                      type: "file" as const,
                      fileId: uploaded.fileId,
                      fileName: uploaded.fileName,
                    });
          await sendMessage({ account, target, message });
        }
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
