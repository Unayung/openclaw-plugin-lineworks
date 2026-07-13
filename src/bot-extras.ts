import { getAccessToken } from "./auth.js";
import type { ResolvedLineWorksAccount } from "./types.js";

const LINEWORKS_API_BASE = "https://www.worksapis.com/v1.0";

export interface LineWorksChannelInfo {
  domainId?: number;
  channelId: string;
  title?: string;
  /** e.g. "SINGLE_USER" | "MULTI_USERS" | "ORGUNIT" | "GROUP" */
  channelType?: string;
  /** Present only when channelType is "ORGUNIT". */
  orgUnitId?: string;
  /** Present only when channelType is "GROUP". */
  groupId?: string;
}

/**
 * Fetch info (title, channel type, ...) for a LINE WORKS talk room the bot
 * participates in.
 *
 * Verified against developers.worksmobile.com/jp/docs/bot-channel-get:
 *   GET /bots/{botId}/channels/{channelId}
 *   scope: bot.message | bot | bot.read (base token scopes already cover this)
 *   response: { domainId, channelId, title, channelType: { type }, orgUnitId?, groupId? }
 *
 * Fails CLOSED: any HTTP error, unexpected shape, or thrown fetch/auth error
 * returns `null` (with the reason logged) — never a fabricated info object.
 */
export async function getChannelInfo(args: {
  account: ResolvedLineWorksAccount;
  channelId: string;
  log?: { warn?: (msg: string) => void };
}): Promise<LineWorksChannelInfo | null> {
  const { account, channelId } = args;
  const warn = (reason: string) =>
    args.log?.warn?.(`LINE WORKS getChannelInfo(${channelId}) failed: ${reason}`);
  if (!channelId) {
    warn("empty channelId");
    return null;
  }

  try {
    const access = await getAccessToken(account);
    const url = `${LINEWORKS_API_BASE}/bots/${encodeURIComponent(account.botId)}/channels/${encodeURIComponent(channelId)}`;
    const res = await fetch(url, {
      headers: { authorization: `${access.tokenType} ${access.token}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      warn(`${res.status} ${text.slice(0, 120)}`);
      return null;
    }

    const json = (await res.json()) as {
      domainId?: unknown;
      channelId?: unknown;
      title?: unknown;
      channelType?: { type?: unknown };
      orgUnitId?: unknown;
      groupId?: unknown;
    };
    if (typeof json.channelId !== "string") {
      warn("unexpected response shape (missing channelId)");
      return null;
    }

    return {
      domainId: typeof json.domainId === "number" ? json.domainId : undefined,
      channelId: json.channelId,
      title: typeof json.title === "string" ? json.title : undefined,
      channelType:
        typeof json.channelType?.type === "string" ? json.channelType.type : undefined,
      orgUnitId: typeof json.orgUnitId === "string" ? json.orgUnitId : undefined,
      groupId: typeof json.groupId === "string" ? json.groupId : undefined,
    };
  } catch (err) {
    warn(err instanceof Error ? err.message : String(err));
    return null;
  }
}

export interface LineWorksPersistentMenuI18nLabel {
  language: string;
  label: string;
}

export interface LineWorksPersistentMenuI18nText {
  language: string;
  text: string;
}

/**
 * A single persistent-menu button. `uri` is required for type "uri";
 * `copyText` is only meaningful for type "copy"; `text`/`postback` are only
 * meaningful for type "message". Up to 4 actions per menu (LINE WORKS limit).
 */
export interface LineWorksPersistentMenuAction {
  type: "message" | "uri" | "copy";
  label: string;
  text?: string;
  postback?: string;
  uri?: string;
  copyText?: string;
  i18nLabels?: LineWorksPersistentMenuI18nLabel[];
  i18nTexts?: LineWorksPersistentMenuI18nText[];
}

export interface LineWorksPersistentMenuContent {
  actions: LineWorksPersistentMenuAction[];
}

export type LineWorksBotExtrasResult = { ok: true } | { ok: false; reason: string };

/**
 * Register (create/replace) the bot's persistent menu.
 *
 * Verified against developers.worksmobile.com/jp/docs/bot-persistentmenu-create:
 *   POST /bots/{botId}/persistentmenu
 *   scope: bot.message | bot (base token scopes already cover this)
 *   body: { content: { actions: [...] } }
 *   success: HTTP 201
 */
export async function registerPersistentMenu(args: {
  account: ResolvedLineWorksAccount;
  content: LineWorksPersistentMenuContent;
  log?: { warn?: (msg: string) => void };
}): Promise<LineWorksBotExtrasResult> {
  const { account, content } = args;
  const warn = (reason: string) => {
    args.log?.warn?.(`LINE WORKS registerPersistentMenu failed: ${reason}`);
    return { ok: false as const, reason };
  };

  try {
    const access = await getAccessToken(account);
    const url = `${LINEWORKS_API_BASE}/bots/${encodeURIComponent(account.botId)}/persistentmenu`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `${access.tokenType} ${access.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return warn(`${res.status} ${text.slice(0, 120)}`);
    }
    return { ok: true };
  } catch (err) {
    return warn(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Fetch the bot's currently registered persistent menu.
 *
 * Verified against developers.worksmobile.com/jp/docs/bot-persistentmenu-get:
 *   GET /bots/{botId}/persistentmenu
 *   scope: bot.message | bot | bot.read (base token scopes already cover this)
 *   response: { content: { actions: [...] } }
 *
 * Fails CLOSED: any HTTP error, unexpected shape, or thrown fetch/auth error
 * returns `null` (with the reason logged).
 */
export async function getPersistentMenu(args: {
  account: ResolvedLineWorksAccount;
  log?: { warn?: (msg: string) => void };
}): Promise<LineWorksPersistentMenuContent | null> {
  const { account } = args;
  const warn = (reason: string) =>
    args.log?.warn?.(`LINE WORKS getPersistentMenu failed: ${reason}`);

  try {
    const access = await getAccessToken(account);
    const url = `${LINEWORKS_API_BASE}/bots/${encodeURIComponent(account.botId)}/persistentmenu`;
    const res = await fetch(url, {
      headers: { authorization: `${access.tokenType} ${access.token}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      warn(`${res.status} ${text.slice(0, 120)}`);
      return null;
    }

    const json = (await res.json()) as { content?: { actions?: unknown } };
    if (!Array.isArray(json.content?.actions)) {
      warn("unexpected response shape (content.actions is not an array)");
      return null;
    }
    return { actions: json.content.actions as LineWorksPersistentMenuAction[] };
  } catch (err) {
    warn(err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Delete the bot's persistent menu.
 *
 * Verified against developers.worksmobile.com/jp/docs/bot-persistentmenu-delete:
 *   DELETE /bots/{botId}/persistentmenu
 *   scope: bot.message | bot (base token scopes already cover this)
 *   success: HTTP 204 (no body)
 */
export async function deletePersistentMenu(args: {
  account: ResolvedLineWorksAccount;
  log?: { warn?: (msg: string) => void };
}): Promise<LineWorksBotExtrasResult> {
  const { account } = args;
  const warn = (reason: string) => {
    args.log?.warn?.(`LINE WORKS deletePersistentMenu failed: ${reason}`);
    return { ok: false as const, reason };
  };

  try {
    const access = await getAccessToken(account);
    const url = `${LINEWORKS_API_BASE}/bots/${encodeURIComponent(account.botId)}/persistentmenu`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: { authorization: `${access.tokenType} ${access.token}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return warn(`${res.status} ${text.slice(0, 120)}`);
    }
    return { ok: true };
  } catch (err) {
    return warn(err instanceof Error ? err.message : String(err));
  }
}
