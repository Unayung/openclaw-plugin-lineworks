import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTask, listTasks } from "./tasks.js";
import { saveOAuthToken } from "./oauth-store.js";
import type { ResolvedLineWorksAccount } from "./types.js";

function makeAccount(): ResolvedLineWorksAccount {
  return {
    accountId: "default",
    enabled: true,
    clientId: "cid",
    clientSecret: "csec",
    serviceAccount: "svc@e.com",
    privateKey: "",
    botId: "bot-1",
    botSecret: "bsec",
    webhookPath: "/lineworks/webhook",
    dmPolicy: "pairing",
    groupPolicy: "allowlist",
    groupRequireMention: false,
    requireMention: false,
    botMentionHandle: undefined,
    allowFrom: [],
    groupAllowFrom: [],
    channels: {},
    extraScopes: [],
    senderProfileEnrichment: true,
    mailPreFetchEnabled: false,
    mailPreFetchCount: 10,
    publicBaseUrl: undefined,
    oauthEnabled: true,
    oauthStartPath: "/oauth/lineworks/start",
    oauthCallbackPath: "/oauth/lineworks/callback",
    oauthScopes: "task,task.read",
    config: {},
  };
}

async function seedUserToken(accountId: string, userId: string): Promise<void> {
  await saveOAuthToken(accountId, {
    userId,
    accessToken: "user-tkn",
    refreshToken: "refresh-tkn",
    tokenType: "Bearer",
    expiresAt: Date.now() + 10 * 60 * 1000,
    scope: "task,task.read",
    grantedAt: new Date().toISOString(),
  });
}

type CapturedCall = {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: string;
};

function mockFetchOnce(response: Response): { calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const mock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    calls.push({
      url: url.toString(),
      method: init?.method,
      headers,
      body: init?.body as string | undefined,
    });
    return response;
  }) as unknown as typeof fetch;
  globalThis.fetch = mock;
  return { calls };
}

describe("tasks", () => {
  const originalFetch = globalThis.fetch;
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lineworks-oauth-test-"));
    process.env.OPENCLAW_HOME = tmpHome;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    delete process.env.OPENCLAW_HOME;
    await fs.promises.rm(tmpHome, { recursive: true, force: true });
  });

  describe("createTask", () => {
    it("POSTs a self-assigned task with the bearer token and returns the created taskId", async () => {
      const account = makeAccount();
      await seedUserToken(account.accountId, "user-1");
      const { calls } = mockFetchOnce(
        new Response(
          JSON.stringify({
            taskId: "task-123",
            title: "Buy milk",
            content: "2% please",
            status: "TODO",
            dueDate: "2026-08-01",
          }),
          { status: 201 },
        ),
      );

      const result = await createTask({
        account,
        userId: "user-1",
        title: "Buy milk",
        dueDate: "2026-08-01",
        memo: "2% please",
      });

      expect(result).toEqual({ ok: true, taskId: "task-123" });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("https://www.worksapis.com/v1.0/users/user-1/tasks");
      expect(calls[0]!.method).toBe("POST");
      expect(calls[0]!.headers.authorization).toBe("Bearer user-tkn");
      expect(calls[0]!.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(calls[0]!.body!)).toEqual({
        assignorId: "user-1",
        assignees: [{ assigneeId: "user-1", status: "TODO" }],
        title: "Buy milk",
        content: "2% please",
        completionCondition: "ANY_ONE",
        dueDate: "2026-08-01",
      });
    });

    it("returns ok:false with a reason on API error (never throws)", async () => {
      const account = makeAccount();
      await seedUserToken(account.accountId, "user-1");
      mockFetchOnce(new Response("bad request", { status: 400 }));
      const warnings: string[] = [];

      const result = await createTask({
        account,
        userId: "user-1",
        title: "Buy milk",
        log: { warn: (m) => warnings.push(m) },
      });

      expect(result.ok).toBe(false);
      expect((result as { ok: false; reason: string }).reason).toContain("400");
      expect(warnings.join("\n")).toContain("400");
    });

    it("returns ok:false without throwing when there is no OAuth grant for the user", async () => {
      const account = makeAccount();
      // no seedUserToken call — user never granted OAuth
      const result = await createTask({ account, userId: "user-1", title: "Buy milk" });

      expect(result).toEqual({ ok: false, reason: "not_authorized" });
    });
  });

  describe("listTasks", () => {
    it("GETs the default-category tasks endpoint and returns summaries", async () => {
      const account = makeAccount();
      await seedUserToken(account.accountId, "user-1");
      const { calls } = mockFetchOnce(
        new Response(
          JSON.stringify({
            tasks: [
              {
                taskId: "task-1",
                title: "Buy milk",
                content: "",
                status: "TODO",
                dueDate: "2026-08-01",
              },
              {
                taskId: "task-2",
                title: "Ship report",
                content: "",
                status: "DONE",
                dueDate: null,
              },
            ],
          }),
          { status: 200 },
        ),
      );

      const tasks = await listTasks({ account, userId: "user-1" });

      expect(tasks).toEqual([
        { taskId: "task-1", title: "Buy milk", status: "TODO", dueDate: "2026-08-01" },
        { taskId: "task-2", title: "Ship report", status: "DONE", dueDate: null },
      ]);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBeUndefined(); // default GET
      expect(calls[0]!.url).toBe(
        "https://www.worksapis.com/v1.0/users/user-1/tasks?categoryId=default&status=ALL",
      );
      expect(calls[0]!.headers.authorization).toBe("Bearer user-tkn");
    });

    it("returns null (not an empty list) on 403", async () => {
      const account = makeAccount();
      await seedUserToken(account.accountId, "user-1");
      mockFetchOnce(new Response("forbidden", { status: 403 }));
      const warnings: string[] = [];

      const tasks = await listTasks({
        account,
        userId: "user-1",
        log: { warn: (m) => warnings.push(m) },
      });

      expect(tasks).toBeNull();
      expect(tasks).not.toEqual([]);
      expect(warnings.join("\n")).toContain("403");
    });

    it("returns null (not an empty list) when there is no OAuth grant for the user", async () => {
      const account = makeAccount();
      // no seedUserToken call — user never granted OAuth

      const tasks = await listTasks({ account, userId: "user-1" });

      expect(tasks).toBeNull();
    });
  });
});
