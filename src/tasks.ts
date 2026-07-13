import { getUserAccessToken } from "./oauth.js";
import type { ResolvedLineWorksAccount } from "./types.js";

const LINEWORKS_API_BASE = "https://www.worksapis.com/v1.0";

export interface CreateTaskArgs {
  account: ResolvedLineWorksAccount;
  /** The user creating (and, self-assigned, completing) the task. */
  userId: string;
  title: string;
  /** `YYYY-MM-DD` (date-only — LINE WORKS does not accept a datetime here). */
  dueDate?: string;
  /** Maps to the API's `content` field. */
  memo?: string;
  log?: { warn?: (msg: string) => void };
}

export type CreateTaskResult = { ok: true; taskId?: string } | { ok: false; reason: string };

/**
 * Create a self-assigned LINE WORKS task.
 *
 * Endpoint: POST /v1.0/users/{userId}/tasks
 * Scope:    `task`
 *
 * Requires a per-user OAuth token (via `getUserAccessToken`) — see
 * specs/tasks.md: LINE WORKS Task endpoints reject service-account (JWT)
 * tokens, unlike some other APIs. Only supports self-assignment (assignor
 * === sole assignee), the only case the chat "create a task for me" flow
 * needs. Never throws; auth/API failures come back as `{ok:false, reason}`.
 */
export async function createTask(args: CreateTaskArgs): Promise<CreateTaskResult> {
  const { account, userId, title, dueDate, memo } = args;
  const warn = (reason: string) =>
    args.log?.warn?.(`LINE WORKS createTask(${userId}) failed: ${reason}`);

  if (!title?.trim()) {
    return { ok: false, reason: "title is required" };
  }

  try {
    const access = await getUserAccessToken({ account, userId, log: args.log });
    if (!access) {
      warn("no OAuth token for user (not authorized)");
      return { ok: false, reason: "not_authorized" };
    }

    const url = `${LINEWORKS_API_BASE}/users/${encodeURIComponent(userId)}/tasks`;
    const payload: Record<string, unknown> = {
      assignorId: userId,
      assignees: [{ assigneeId: userId, status: "TODO" }],
      title,
      content: memo ?? "",
      completionCondition: "ANY_ONE",
      dueDate: dueDate ?? null,
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${access.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      warn(`${res.status} ${text.slice(0, 200)}`);
      return { ok: false, reason: `${res.status} ${text.slice(0, 200)}` };
    }

    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    // Docs' schema table wraps the task in a `task` key; the docs' own
    // verbatim example response does not. Tolerate both.
    const taskObj = ((json.task as Record<string, unknown> | undefined) ?? json) as Record<
      string,
      unknown
    >;
    const taskId = typeof taskObj.taskId === "string" ? taskObj.taskId : undefined;
    return taskId ? { ok: true, taskId } : { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warn(reason);
    return { ok: false, reason };
  }
}

export interface LineWorksTaskSummary {
  taskId: string;
  title?: string;
  status?: string;
  /** `YYYY-MM-DD`, or `null` when the task has no due date. */
  dueDate?: string | null;
}

/**
 * List the current user's tasks in the default task category.
 *
 * Endpoint: GET /v1.0/users/{userId}/tasks
 * Scope:    `task` or `task.read`
 *
 * LINE WORKS documents `categoryId` as a *required* query param — there is
 * no "list everything" call. Since `createTask` above never sets a
 * `categoryId`, every task it creates lands in the reserved default
 * category (documented literal id `"default"`), so that's what this reads.
 * `status=ALL` so both open and completed tasks are included. This reads
 * only the first page (LINE WORKS max `count`=100) — no cursor-following
 * loop, since this is a "recent tasks for chat context" read, not an
 * export.
 *
 * Fails CLOSED: any HTTP error (e.g. 403 for a missing/insufficient token),
 * unexpected response shape, or thrown error returns `null` — never an
 * empty array a caller could mistake for "no tasks".
 */
export async function listTasks(args: {
  account: ResolvedLineWorksAccount;
  userId: string;
  log?: { warn?: (msg: string) => void };
}): Promise<LineWorksTaskSummary[] | null> {
  const { account, userId } = args;
  const warn = (reason: string) =>
    args.log?.warn?.(`LINE WORKS listTasks(${userId}) failed: ${reason}`);

  try {
    const access = await getUserAccessToken({ account, userId, log: args.log });
    if (!access) {
      warn("no OAuth token for user (not authorized)");
      return null;
    }

    const qs = new URLSearchParams({ categoryId: "default", status: "ALL" });
    const url = `${LINEWORKS_API_BASE}/users/${encodeURIComponent(userId)}/tasks?${qs.toString()}`;

    const res = await fetch(url, { headers: { authorization: `Bearer ${access.token}` } });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      warn(`${res.status} ${text.slice(0, 200)}`);
      return null;
    }

    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const tasks = json["tasks"];
    if (!Array.isArray(tasks)) {
      warn("unexpected response shape (tasks is not an array)");
      return null;
    }

    return tasks.map((t) => {
      const entry = t as Record<string, unknown>;
      return {
        taskId: String(entry["taskId"] ?? ""),
        title: typeof entry["title"] === "string" ? (entry["title"] as string) : undefined,
        status: typeof entry["status"] === "string" ? (entry["status"] as string) : undefined,
        dueDate:
          typeof entry["dueDate"] === "string"
            ? (entry["dueDate"] as string)
            : entry["dueDate"] === null
              ? null
              : undefined,
      };
    });
  } catch (err) {
    warn(err instanceof Error ? err.message : String(err));
    return null;
  }
}
