import { getUserAccessToken } from "./oauth.js";
import type { ResolvedLineWorksAccount } from "./types.js";

const LINEWORKS_API_BASE = "https://www.worksapis.com/v1.0";
const LIST_PAGE_COUNT = 100; // API max per page is 200; default is 100
// ponytail: cursor-loop safety cap, mirrors members.ts's MAX_PAGES
const MAX_PAGES = 200;
const TITLE_MAX_CHARS = 200;
const BODY_MAX_CHARS = 716_800;

/**
 * The hint logged (and returned as `reason` on write failures) when the
 * requesting user has no LINE WORKS OAuth grant, or the grant lacks the
 * `board`/`board.read` scope. Board API accepts BOTH service-account (JWT)
 * and per-user OAuth tokens per LINE WORKS docs (developers.worksmobile.com/
 * jp/docs/board), but this module always uses per-user OAuth so posts are
 * attributed to the requesting chat user, not the bot's service account —
 * see the spec for the full auth-mode decision + evidence. Because of that,
 * `board`/`board.read` is intentionally NOT added to auth.ts's service-account
 * BASE_SCOPES; the gap to close is `channels.lineworks.oauth.scopes`, which
 * (as of writing) does not include `board`/`board.read` by default either.
 */
const NO_GRANT_HINT =
  "no LINE WORKS OAuth grant for this user (or grant lacks `board`/`board.read` scope) — " +
  "add \"board\" (write) or \"board.read\" (read-only) to channels.lineworks.oauth.scopes " +
  "and have the user re-run the OAuth grant flow";

export interface LineWorksBoardSummary {
  boardId: string;
  boardName: string;
  description?: string;
}

export interface LineWorksListBoardsArgs {
  account: ResolvedLineWorksAccount;
  /** LINE WORKS userId whose per-user OAuth grant authenticates the call. */
  userId: string;
  /** Filter to boards the user can read (default) or write to. */
  role?: "READER" | "WRITER";
  log?: { warn?: (msg: string) => void };
}

/**
 * List boards visible to `userId`.
 *
 * Verified against developers.worksmobile.com/jp/reference/board-list:
 *   GET /v1.0/boards?role=READER|WRITER&count=100[&cursor=…]
 *   scope: board | board.read
 *   response: { "boards": [{ "boardId": 100, "boardName": "…",
 *               "description": "…", … }], "responseMetaData": { "nextCursor": "…" } }
 *
 * Fails CLOSED: no OAuth grant, any HTTP error, unexpected response shape, or
 * pagination overflow all return `null` (reason logged) — never an empty
 * array a caller could mistake for "this tenant has zero boards".
 */
export async function listBoards(
  args: LineWorksListBoardsArgs,
): Promise<LineWorksBoardSummary[] | null> {
  const { account, userId } = args;
  const warn = (reason: string) => args.log?.warn?.(`LINE WORKS listBoards failed: ${reason}`);
  if (!userId) {
    warn("empty userId");
    return null;
  }

  try {
    const oauth = await getUserAccessToken({ account, userId, log: args.log });
    if (!oauth) {
      warn(NO_GRANT_HINT);
      return null;
    }

    const boards: LineWorksBoardSummary[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`${LINEWORKS_API_BASE}/boards`);
      url.searchParams.set("role", args.role ?? "READER");
      url.searchParams.set("count", String(LIST_PAGE_COUNT));
      if (cursor) url.searchParams.set("cursor", cursor);

      const res = await fetch(url, {
        headers: { authorization: `Bearer ${oauth.token}` },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const hint = res.status === 401 || res.status === 403 ? ` — ${NO_GRANT_HINT}` : "";
        warn(`${res.status} ${text.slice(0, 120)}${hint}`);
        return null;
      }

      const json = (await res.json()) as {
        boards?: unknown;
        responseMetaData?: { nextCursor?: unknown };
      };
      if (!Array.isArray(json.boards)) {
        warn("unexpected response shape (boards is not an array)");
        return null;
      }

      for (const entry of json.boards) {
        if (!entry || typeof entry !== "object") {
          warn("unexpected response shape (board entry is not an object)");
          return null;
        }
        const rec = entry as Record<string, unknown>;
        const boardId = rec["boardId"];
        const boardName = rec["boardName"];
        if (
          (typeof boardId !== "number" && typeof boardId !== "string") ||
          typeof boardName !== "string"
        ) {
          warn("unexpected response shape (missing boardId/boardName)");
          return null;
        }
        boards.push({
          boardId: String(boardId),
          boardName,
          description: typeof rec["description"] === "string" ? rec["description"] : undefined,
        });
      }

      const next = json.responseMetaData?.nextCursor;
      if (typeof next !== "string" || next === "") {
        return boards;
      }
      cursor = next;
    }

    warn(`pagination exceeded ${MAX_PAGES} pages`);
    return null;
  } catch (err) {
    warn(err instanceof Error ? err.message : String(err));
    return null;
  }
}

export interface LineWorksCreateBoardPostArgs {
  account: ResolvedLineWorksAccount;
  /** LINE WORKS userId whose per-user OAuth grant authenticates the call — the post is attributed to this user. */
  userId: string;
  boardId: string;
  /** 1–200 chars. */
  title: string;
  /** 1–716,800 chars. HTML content (LINE WORKS Board post bodies are HTML, not plain text) — `<script>` etc. is rejected server-side. */
  body: string;
  /** Allow comments on the post. LINE WORKS default: true. */
  enableComment?: boolean;
  /** Notify board members of the new post. LINE WORKS default: true. */
  sendNotifications?: boolean;
  /** `YYYY-MM-DD`, must be within 30 days of today. Marks the post "must read" until this date. */
  mustReadEndDate?: string;
  log?: { warn?: (msg: string) => void };
}

export type LineWorksCreateBoardPostResult =
  | { ok: true; postId?: string }
  | { ok: false; reason: string };

/**
 * Create a post on a LINE WORKS board.
 *
 * Verified against developers.worksmobile.com/jp/reference/board-post-create:
 *   POST /v1.0/boards/{boardId}/posts
 *   scope: board
 *   body: { title, body, enableComment?, sendNotifications?, mustReadEndDate? }
 *   response 201: { boardId, postId, title, …, userId, userName }
 *
 * Never throws — every failure (bad input, no OAuth grant, HTTP error,
 * thrown fetch/auth error) resolves to `{ ok: false, reason }` so callers
 * always get an honest, actionable result instead of an unhandled rejection.
 */
export async function createBoardPost(
  args: LineWorksCreateBoardPostArgs,
): Promise<LineWorksCreateBoardPostResult> {
  const { account, userId, boardId, title, body } = args;
  const warn = (reason: string) =>
    args.log?.warn?.(`LINE WORKS createBoardPost(${boardId}) failed: ${reason}`);

  if (!userId) return { ok: false, reason: "empty userId" };
  if (!boardId) return { ok: false, reason: "empty boardId" };
  if (!title) return { ok: false, reason: "title is required" };
  if (title.length > TITLE_MAX_CHARS) {
    return { ok: false, reason: `title exceeds ${TITLE_MAX_CHARS} characters` };
  }
  if (!body) return { ok: false, reason: "body is required" };
  if (body.length > BODY_MAX_CHARS) {
    return { ok: false, reason: `body exceeds ${BODY_MAX_CHARS} characters` };
  }

  try {
    const oauth = await getUserAccessToken({ account, userId, log: args.log });
    if (!oauth) {
      warn(NO_GRANT_HINT);
      return { ok: false, reason: NO_GRANT_HINT };
    }

    const url = `${LINEWORKS_API_BASE}/boards/${encodeURIComponent(boardId)}/posts`;
    const payload: Record<string, unknown> = { title, body };
    if (args.enableComment !== undefined) payload.enableComment = args.enableComment;
    if (args.sendNotifications !== undefined) payload.sendNotifications = args.sendNotifications;
    if (args.mustReadEndDate !== undefined) payload.mustReadEndDate = args.mustReadEndDate;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${oauth.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const hint = res.status === 401 || res.status === 403 ? ` — ${NO_GRANT_HINT}` : "";
      const reason = `${res.status} ${text.slice(0, 200)}${hint}`;
      warn(reason);
      return { ok: false, reason };
    }

    const json = (await res.json().catch(() => ({}))) as { postId?: unknown };
    const postId = json.postId;
    return {
      ok: true,
      postId: typeof postId === "number" || typeof postId === "string" ? String(postId) : undefined,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warn(reason);
    return { ok: false, reason };
  }
}
