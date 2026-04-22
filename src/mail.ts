import { getAccessToken } from "./auth.js";
import type { ResolvedLineWorksAccount } from "./types.js";

const LINEWORKS_API_BASE = "https://www.worksapis.com/v1.0";

export interface LineWorksMailAddress {
  email: string;
  name?: string;
}

export interface LineWorksSendMailArgs {
  account: ResolvedLineWorksAccount;
  /**
   * The mailbox to send FROM. Must be an email whose domain is managed by
   * this LINE WORKS tenant. When omitted, falls back to the bot's service
   * account email — which is only valid if the service account has its own
   * mailbox (rare; usually you pass a real user email).
   *
   * For user-delegated send, the service-account JWT must be minted with
   * `sub=<userEmail>` (domain-wide delegation) — that's handled inside
   * getAccessToken when we grow that capability. For now this function
   * sends as whatever identity the current token represents.
   */
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  /** `text` (default) or `html`. */
  mimeType?: "text/plain" | "text/html";
}

export interface LineWorksSendMailResult {
  messageId?: string;
}

/**
 * Send mail via the LINE WORKS Mail API.
 *
 * Endpoint: POST /v1.0/users/{userEmail}/mail
 * Scope:    `mail`
 *
 * `{userEmail}` is the *sender* mailbox, not the bot's userId — LINE WORKS
 * routes mail per-user, not per-bot. If the current service-account token
 * doesn't have permission on that mailbox (admin hasn't granted domain-wide
 * delegation, or scope is missing), the API returns 401/403.
 */
export async function sendMail(args: LineWorksSendMailArgs): Promise<LineWorksSendMailResult> {
  const { account, from, to, cc, bcc, subject, body } = args;
  if (!from) throw new Error("LINE WORKS sendMail: `from` is required (sender mailbox email)");
  if (!to || to.length === 0) {
    throw new Error("LINE WORKS sendMail: at least one recipient in `to` is required");
  }

  const access = await getAccessToken(account);
  const url = `${LINEWORKS_API_BASE}/users/${encodeURIComponent(from)}/mail`;

  const payload: Record<string, unknown> = {
    subject,
    recipients: [
      ...to.map((email) => ({ email, type: "TO" })),
      ...(cc ?? []).map((email) => ({ email, type: "CC" })),
      ...(bcc ?? []).map((email) => ({ email, type: "BCC" })),
    ],
    body: {
      contentType: args.mimeType ?? "text/plain",
      content: body,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `${access.tokenType} ${access.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LINE WORKS mail send failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const json = (await res.json().catch(() => ({}))) as { mailId?: string; id?: string };
  return { messageId: json.mailId ?? json.id };
}

export interface LineWorksListMailArgs {
  account: ResolvedLineWorksAccount;
  /**
   * Mailbox to read from. Accepts the sender's UUID userId, email, or
   * the literal string "me" (when `userAccessToken` represents that user).
   * Must be URL-encoded downstream — this helper handles that.
   */
  userEmail: string;
  /**
   * Pre-obtained user-scope OAuth access token. REQUIRED for mail read —
   * service-account JWT tokens are rejected by LINE WORKS with 403
   * "Not allowed api" on mail endpoints. When omitted, falls back to the
   * service-account token (which will 403 on most tenants).
   */
  userAccessToken?: string;
  /** Max messages to return. Default 10. LINE WORKS enforces min 5, max 200. */
  limit?: number;
  /**
   * Folder id to list. Defaults to 0 (system "Inbox"). System folders by
   * LINE WORKS convention:
   *   0 = Inbox
   *   1 = Sent
   *   others — user-created / system folders (draft, trash, ...)
   * Use `listMailFolders` to enumerate.
   */
  folderId?: number;
  /** Optional: only list unread. */
  unreadOnly?: boolean;
  /** Server-side filter. Default "all". */
  searchFilterType?: "all" | "mark" | "attach" | "tome";
}

export interface LineWorksMailSummary {
  id: string;
  subject?: string;
  from?: string;
  to?: string[];
  snippet?: string;
  receivedAt?: string;
  isUnread?: boolean;
  isImportant?: boolean;
  attachCount?: number;
}

export interface LineWorksMailFolder {
  folderId: number;
  folderType: "S" | "U";
  folderName: string;
  unreadMailCount: number;
  mailCount: number;
}

/**
 * List folders available in a user's mailbox. Inbox is typically folderId=0
 * and is the default target for `listRecentMail`. Scope: `mail.read` or `mail`.
 */
export async function listMailFolders(args: {
  account: ResolvedLineWorksAccount;
  userEmail: string;
}): Promise<LineWorksMailFolder[]> {
  const { account, userEmail } = args;
  const access = await getAccessToken(account);
  const url = `${LINEWORKS_API_BASE}/users/${encodeURIComponent(userEmail)}/mail/mailfolders`;
  const res = await fetch(url, {
    headers: { authorization: `${access.tokenType} ${access.token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `LINE WORKS mail folder list failed: ${res.status} ${text.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as { mailFolders?: LineWorksMailFolder[] };
  return json.mailFolders ?? [];
}

/**
 * Heuristic "the user wants me to check their inbox" detector. Matches common
 * Chinese + English phrasings; erring on the side of high-recall since a false
 * positive just means the agent sees an extra RecentMail context block it can
 * ignore (whereas a false negative means the whole feature looks broken).
 */
const MAIL_CHECK_PATTERN =
  /(查看|看一下|看看|檢查|讀|打開|瀏覽).{0,6}(信箱|郵件|信件|電郵|email|mail|inbox)|我的\s*(信箱|郵件|mail|inbox)|(check|read|browse|look\s*at|show\s*me)\s*(my\s*)?(mail|inbox|email)|(mail|inbox|email)\s*(status|summary|overview|digest)/i;

export function looksLikeMailCheckRequest(text: string): boolean {
  if (!text) return false;
  return MAIL_CHECK_PATTERN.test(text);
}

/**
 * Format a list of mail summaries into a compact markdown-ish block the agent
 * can drop into its reply verbatim or reason over. Truncates snippets so the
 * block stays bounded even for a big inbox.
 */
export function formatMailSummaries(
  mails: LineWorksMailSummary[],
  opts?: { maxSnippetChars?: number },
): string {
  if (mails.length === 0) return "(inbox empty or no matching messages)";
  const maxSnip = opts?.maxSnippetChars ?? 140;
  const lines: string[] = [];
  lines.push(`${mails.length} recent mail:`);
  lines.push("");
  mails.forEach((m, i) => {
    const unreadMark = m.isUnread ? " 🔵" : "";
    const importantMark = m.isImportant ? " ❗" : "";
    const attachMark = m.attachCount && m.attachCount > 0 ? ` 📎${m.attachCount}` : "";
    const when = m.receivedAt ? ` · ${m.receivedAt}` : "";
    const subject = m.subject?.trim() || "(no subject)";
    const from = m.from ? ` — from ${m.from}` : "";
    lines.push(
      `${i + 1}. ${subject}${unreadMark}${importantMark}${attachMark}${from}${when}`,
    );
    if (m.snippet) {
      const snip = m.snippet.trim().replace(/\s+/g, " ").slice(0, maxSnip);
      if (snip) lines.push(`   ${snip}${m.snippet.length > maxSnip ? "…" : ""}`);
    }
  });
  return lines.join("\n");
}

/**
 * List recent mail in a folder.
 *
 * Endpoint: GET /v1.0/users/{userId}/mail/mailfolders/{folderId}/children
 * Scope:    `mail` or `mail.read`
 *
 * Defaults to folderId=0 (Inbox). `count` must be between 5 and 200 per
 * LINE WORKS; values outside that range are clamped. The LINE WORKS API
 * does NOT return a body snippet — only metadata (subject, from, to,
 * timestamps, flags). If you need body content, call `getMail` by `mailId`.
 */
export async function listRecentMail(
  args: LineWorksListMailArgs,
): Promise<LineWorksMailSummary[]> {
  const { account, userEmail } = args;
  const folderId = args.folderId ?? 0;
  const limit = Math.min(200, Math.max(5, args.limit ?? 10));
  const qs = new URLSearchParams();
  qs.set("count", String(limit));
  if (args.unreadOnly) qs.set("isUnread", "true");
  qs.set("searchFilterType", args.searchFilterType ?? "all");
  const url = `${LINEWORKS_API_BASE}/users/${encodeURIComponent(
    userEmail,
  )}/mail/mailfolders/${encodeURIComponent(String(folderId))}/children?${qs.toString()}`;
  const authHeader = args.userAccessToken
    ? `Bearer ${args.userAccessToken}`
    : await (async () => {
        const access = await getAccessToken(account);
        return `${access.tokenType} ${access.token}`;
      })();
  const res = await fetch(url, {
    headers: { authorization: authHeader },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LINE WORKS mail list failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  const list = (json["mails"] as Array<Record<string, unknown>> | undefined) ?? [];

  return list.map((m) => {
    const from = m["from"];
    const fromEmail =
      typeof from === "object" && from !== null
        ? ((from as Record<string, unknown>)["email"] as string | undefined)
        : undefined;
    const to = m["to"];
    const toEmails = Array.isArray(to)
      ? (to
          .map((t) =>
            typeof t === "object" && t !== null
              ? ((t as Record<string, unknown>)["email"] as string | undefined)
              : undefined,
          )
          .filter((x): x is string => !!x))
      : undefined;
    const status = typeof m["status"] === "string" ? (m["status"] as string) : undefined;
    return {
      id: String(m["mailId"] ?? ""),
      subject: typeof m["subject"] === "string" ? (m["subject"] as string) : undefined,
      from: fromEmail,
      to: toEmails,
      receivedAt:
        typeof m["receivedTime"] === "string" ? (m["receivedTime"] as string) : undefined,
      isUnread: status ? status === "Unread" : undefined,
      isImportant:
        typeof m["isImportant"] === "boolean" ? (m["isImportant"] as boolean) : undefined,
      attachCount:
        typeof m["attachCount"] === "number" ? (m["attachCount"] as number) : undefined,
    };
  });
}
