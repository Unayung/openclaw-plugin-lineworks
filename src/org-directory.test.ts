import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { exportPKCS8 } from "jose";
import { clearAccessTokenCache } from "./auth.js";
import { listGroups, listUsers } from "./org-directory.js";
import type { ResolvedLineWorksAccount } from "./types.js";

function makeAccount(privateKeyPem: string): ResolvedLineWorksAccount {
  return {
    accountId: "default",
    enabled: true,
    clientId: "cid",
    clientSecret: "csec",
    serviceAccount: "svc@e.com",
    privateKey: privateKeyPem,
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
    oauthEnabled: false,
    oauthStartPath: "/oauth/lineworks/start",
    oauthCallbackPath: "/oauth/lineworks/callback",
    oauthScopes: "mail,mail.read",
    config: {},
  };
}

async function setupAccount() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = await exportPKCS8(privateKey);
  return makeAccount(privateKeyPem);
}

function mockFetchSequence(responses: Response[]): {
  calls: { url: string; method?: string; headers: Record<string, string> }[];
  mock: typeof fetch;
} {
  const calls: { url: string; method?: string; headers: Record<string, string> }[] = [];
  const queue = [...responses];
  const mock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    calls.push({ url: url.toString(), method: init?.method, headers });
    if (url.toString().includes("/oauth2/")) {
      return new Response(
        JSON.stringify({ access_token: "tkn", token_type: "Bearer", expires_in: 3600 }),
        { status: 200 },
      );
    }
    return queue.shift() ?? new Response("{}", { status: 500 });
  }) as unknown as typeof fetch;
  return { calls, mock };
}

function usersPage(
  users: { userId: string; email?: string; userName?: { firstName?: string; lastName?: string } }[],
  nextCursor?: string,
): Response {
  return new Response(
    JSON.stringify({
      users,
      responseMetaData: nextCursor !== undefined ? { nextCursor } : undefined,
    }),
    { status: 200 },
  );
}

function groupsPage(
  groups: { groupId: string; groupName?: string }[],
  nextCursor?: string,
): Response {
  return new Response(
    JSON.stringify({
      groups,
      responseMetaData: nextCursor !== undefined ? { nextCursor } : undefined,
    }),
    { status: 200 },
  );
}

describe("listUsers", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearAccessTokenCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("GETs the users endpoint and returns minimal profiles", async () => {
    const account = await setupAccount();
    const { calls, mock } = mockFetchSequence([
      usersPage([
        { userId: "u-1", email: "u1@example.com", userName: { firstName: "太郎", lastName: "ワークス" } },
      ]),
    ]);
    globalThis.fetch = mock;

    const users = await listUsers({ account });

    expect(users).toEqual([{ userId: "u-1", email: "u1@example.com", displayName: "ワークス太郎" }]);
    const req = calls.find((c) => c.url.includes("/users"));
    expect(req).toBeDefined();
    expect(req!.url).toBe("https://www.worksapis.com/v1.0/users?count=100");
    expect(req!.headers.authorization).toBe("Bearer tkn");
  });

  it("follows nextCursor across pages and concatenates users", async () => {
    const account = await setupAccount();
    const { calls, mock } = mockFetchSequence([
      usersPage([{ userId: "u-1" }, { userId: "u-2" }], "cur-2"),
      usersPage([{ userId: "u-3" }], ""),
    ]);
    globalThis.fetch = mock;

    const users = await listUsers({ account });

    expect(users).toEqual([{ userId: "u-1" }, { userId: "u-2" }, { userId: "u-3" }]);
    const userCalls = calls.filter((c) => c.url.includes("/users"));
    expect(userCalls).toHaveLength(2);
    expect(userCalls[1]!.url).toContain("cursor=cur-2");
  });

  it("returns null (not an empty roster) on 403 with a scope hint in the warn log", async () => {
    const account = await setupAccount();
    const warnings: string[] = [];
    const { mock } = mockFetchSequence([new Response("forbidden", { status: 403 })]);
    globalThis.fetch = mock;

    const users = await listUsers({ account, log: { warn: (m) => warnings.push(m) } });

    expect(users).toBeNull();
    expect(users).not.toEqual([]);
    const joined = warnings.join("\n");
    expect(joined).toContain("403");
    expect(joined).toContain("user.read");
    expect(joined).toContain("extraScopes");
  });

  it("returns null on an unexpected response shape", async () => {
    const account = await setupAccount();
    const { mock } = mockFetchSequence([
      new Response(JSON.stringify({ users: [{ noUserId: true }] }), { status: 200 }),
    ]);
    globalThis.fetch = mock;

    const users = await listUsers({ account });

    expect(users).toBeNull();
  });
});

describe("listGroups", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearAccessTokenCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("GETs the groups endpoint and returns minimal profiles", async () => {
    const account = await setupAccount();
    const { calls, mock } = mockFetchSequence([
      groupsPage([{ groupId: "g-1", groupName: "グループ1" }]),
    ]);
    globalThis.fetch = mock;

    const groups = await listGroups({ account });

    expect(groups).toEqual([{ groupId: "g-1", groupName: "グループ1" }]);
    const req = calls.find((c) => c.url.includes("/groups"));
    expect(req).toBeDefined();
    expect(req!.url).toBe("https://www.worksapis.com/v1.0/groups?count=100");
    expect(req!.headers.authorization).toBe("Bearer tkn");
  });

  it("follows nextCursor across pages and concatenates groups", async () => {
    const account = await setupAccount();
    const { calls, mock } = mockFetchSequence([
      groupsPage([{ groupId: "g-1" }, { groupId: "g-2" }], "cur-2"),
      groupsPage([{ groupId: "g-3" }], ""),
    ]);
    globalThis.fetch = mock;

    const groups = await listGroups({ account });

    expect(groups).toEqual([{ groupId: "g-1" }, { groupId: "g-2" }, { groupId: "g-3" }]);
    const groupCalls = calls.filter((c) => c.url.includes("/groups"));
    expect(groupCalls).toHaveLength(2);
    expect(groupCalls[1]!.url).toContain("cursor=cur-2");
  });

  it("returns null (not an empty roster) on 403 with a scope hint in the warn log", async () => {
    const account = await setupAccount();
    const warnings: string[] = [];
    const { mock } = mockFetchSequence([new Response("forbidden", { status: 403 })]);
    globalThis.fetch = mock;

    const groups = await listGroups({ account, log: { warn: (m) => warnings.push(m) } });

    expect(groups).toBeNull();
    expect(groups).not.toEqual([]);
    const joined = warnings.join("\n");
    expect(joined).toContain("403");
    expect(joined).toContain("group.read");
    expect(joined).toContain("extraScopes");
  });

  it("returns null on an unexpected response shape", async () => {
    const account = await setupAccount();
    const { mock } = mockFetchSequence([
      new Response(JSON.stringify({ groups: [{ noGroupId: true }] }), { status: 200 }),
    ]);
    globalThis.fetch = mock;

    const groups = await listGroups({ account });

    expect(groups).toBeNull();
  });
});
