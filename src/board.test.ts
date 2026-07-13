import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBoardPost, listBoards } from "./board.js";
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
    oauthScopes: "board,board.read",
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
    scope: "board,board.read",
    grantedAt: new Date().toISOString(),
  });
}

type CapturedCall = {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: string;
};

function mockFetchSequence(responses: Response[]): { calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const queue = [...responses];
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
    return queue.shift() ?? new Response("{}", { status: 500 });
  }) as unknown as typeof fetch;
  globalThis.fetch = mock;
  return { calls };
}

describe("board", () => {
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

  describe("listBoards", () => {
    it("GETs the boards endpoint and returns summaries", async () => {
      const account = makeAccount();
      await seedUserToken(account.accountId, "user-1");
      const { calls } = mockFetchSequence([
        new Response(
          JSON.stringify({
            boards: [
              { boardId: 100, boardName: "Notice", description: "Notice Description" },
              { boardId: 101, boardName: "Random" },
            ],
          }),
          { status: 200 },
        ),
      ]);

      const boards = await listBoards({ account, userId: "user-1" });

      expect(boards).toEqual([
        { boardId: "100", boardName: "Notice", description: "Notice Description" },
        { boardId: "101", boardName: "Random", description: undefined },
      ]);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(
        "https://www.worksapis.com/v1.0/boards?role=READER&count=100",
      );
      expect(calls[0]!.headers.authorization).toBe("Bearer user-tkn");
    });

    it("follows nextCursor across pages and concatenates boards", async () => {
      const account = makeAccount();
      await seedUserToken(account.accountId, "user-1");
      const { calls } = mockFetchSequence([
        new Response(
          JSON.stringify({
            boards: [{ boardId: 1, boardName: "A" }],
            responseMetaData: { nextCursor: "cur-2" },
          }),
          { status: 200 },
        ),
        new Response(
          JSON.stringify({
            boards: [{ boardId: 2, boardName: "B" }],
            responseMetaData: { nextCursor: "" },
          }),
          { status: 200 },
        ),
      ]);

      const boards = await listBoards({ account, userId: "user-1" });

      expect(boards).toEqual([
        { boardId: "1", boardName: "A", description: undefined },
        { boardId: "2", boardName: "B", description: undefined },
      ]);
      expect(calls).toHaveLength(2);
      expect(calls[1]!.url).toContain("cursor=cur-2");
    });

    it("returns null (not an empty list) on 403, with a scope hint in the warn log", async () => {
      const account = makeAccount();
      await seedUserToken(account.accountId, "user-1");
      mockFetchSequence([new Response("forbidden", { status: 403 })]);
      const warnings: string[] = [];

      const boards = await listBoards({
        account,
        userId: "user-1",
        log: { warn: (m) => warnings.push(m) },
      });

      expect(boards).toBeNull();
      expect(boards).not.toEqual([]);
      expect(warnings.join("\n")).toContain("403");
      expect(warnings.join("\n")).toMatch(/board.*scope|scope.*board/i);
    });

    it("returns null (not an empty list) when there is no OAuth grant for the user", async () => {
      const account = makeAccount();
      // no seedUserToken() — user never authorized
      const warnings: string[] = [];

      const boards = await listBoards({
        account,
        userId: "user-unauthorized",
        log: { warn: (m) => warnings.push(m) },
      });

      expect(boards).toBeNull();
      expect(warnings.join("\n")).toMatch(/oauth|grant/i);
    });

    it("returns null on an unexpected response shape", async () => {
      const account = makeAccount();
      await seedUserToken(account.accountId, "user-1");
      mockFetchSequence([
        new Response(JSON.stringify({ boards: [{ boardName: "no id" }] }), { status: 200 }),
      ]);

      const boards = await listBoards({ account, userId: "user-1" });

      expect(boards).toBeNull();
    });
  });

  describe("createBoardPost", () => {
    it("POSTs the post with the bearer token and returns the created postId", async () => {
      const account = makeAccount();
      await seedUserToken(account.accountId, "user-1");
      const { calls } = mockFetchSequence([
        new Response(
          JSON.stringify({
            boardId: 100,
            postId: 1,
            title: "Example title",
            userId: "user-1",
            userName: "Susan Nielsen",
          }),
          { status: 201 },
        ),
      ]);

      const result = await createBoardPost({
        account,
        userId: "user-1",
        boardId: "100",
        title: "Example title",
        body: "<h1>Example</h1> Insert body here.",
      });

      expect(result).toEqual({ ok: true, postId: "1" });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("https://www.worksapis.com/v1.0/boards/100/posts");
      expect(calls[0]!.method).toBe("POST");
      expect(calls[0]!.headers.authorization).toBe("Bearer user-tkn");
      expect(calls[0]!.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(calls[0]!.body!)).toEqual({
        title: "Example title",
        body: "<h1>Example</h1> Insert body here.",
      });
    });

    it("includes optional fields in the body when provided", async () => {
      const account = makeAccount();
      await seedUserToken(account.accountId, "user-1");
      const { calls } = mockFetchSequence([
        new Response(JSON.stringify({ boardId: 100, postId: 2 }), { status: 201 }),
      ]);

      await createBoardPost({
        account,
        userId: "user-1",
        boardId: "100",
        title: "Announcement",
        body: "<p>hi</p>",
        enableComment: false,
        sendNotifications: false,
        mustReadEndDate: "2026-08-01",
      });

      expect(JSON.parse(calls[0]!.body!)).toEqual({
        title: "Announcement",
        body: "<p>hi</p>",
        enableComment: false,
        sendNotifications: false,
        mustReadEndDate: "2026-08-01",
      });
    });

    it("returns ok:false with a reason on API error (never throws)", async () => {
      const account = makeAccount();
      await seedUserToken(account.accountId, "user-1");
      mockFetchSequence([new Response("bad request", { status: 400 })]);
      const warnings: string[] = [];

      const result = await createBoardPost({
        account,
        userId: "user-1",
        boardId: "100",
        title: "Example title",
        body: "<p>body</p>",
        log: { warn: (m) => warnings.push(m) },
      });

      expect(result.ok).toBe(false);
      expect((result as { ok: false; reason: string }).reason).toContain("400");
      expect(warnings.join("\n")).toContain("400");
    });

    it("returns ok:false with a scope hint on 403", async () => {
      const account = makeAccount();
      await seedUserToken(account.accountId, "user-1");
      mockFetchSequence([new Response("forbidden", { status: 403 })]);

      const result = await createBoardPost({
        account,
        userId: "user-1",
        boardId: "100",
        title: "Example title",
        body: "<p>body</p>",
      });

      expect(result.ok).toBe(false);
      const reason = (result as { ok: false; reason: string }).reason;
      expect(reason).toContain("403");
      expect(reason).toMatch(/board.*scope|scope.*board/i);
    });

    it("returns ok:false without a network call when there is no OAuth grant", async () => {
      const account = makeAccount();
      // no seedUserToken() — user never authorized
      const { calls } = mockFetchSequence([]);

      const result = await createBoardPost({
        account,
        userId: "user-unauthorized",
        boardId: "100",
        title: "Example title",
        body: "<p>body</p>",
      });

      expect(result.ok).toBe(false);
      expect(calls).toHaveLength(0);
    });

    it("returns ok:false without a network call when title or body is missing", async () => {
      const account = makeAccount();
      await seedUserToken(account.accountId, "user-1");
      const { calls } = mockFetchSequence([]);

      const noTitle = await createBoardPost({
        account,
        userId: "user-1",
        boardId: "100",
        title: "",
        body: "<p>body</p>",
      });
      const noBody = await createBoardPost({
        account,
        userId: "user-1",
        boardId: "100",
        title: "Title",
        body: "",
      });

      expect(noTitle).toEqual({ ok: false, reason: expect.stringContaining("title") });
      expect(noBody).toEqual({ ok: false, reason: expect.stringContaining("body") });
      expect(calls).toHaveLength(0);
    });
  });
});
