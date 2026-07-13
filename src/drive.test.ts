import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("./oauth.js", () => ({
  getUserAccessToken: vi.fn(),
}));

import { getUserAccessToken } from "./oauth.js";
import { createDriveShareLink, listDriveFiles, uploadDriveFile } from "./drive.js";
import type { ResolvedLineWorksAccount } from "./types.js";

const mockGetUserAccessToken = vi.mocked(getUserAccessToken);

function makeAccount(): ResolvedLineWorksAccount {
  return {
    accountId: "default",
    enabled: true,
    clientId: "cid",
    clientSecret: "csec",
    serviceAccount: "svc@e.com",
    privateKey: "unused-for-drive",
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
    oauthScopes: "file,file.read",
    config: {},
  };
}

type CapturedCall = {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: unknown;
};

function mockFetchSequence(responses: Response[]): { calls: CapturedCall[]; mock: typeof fetch } {
  const calls: CapturedCall[] = [];
  const queue = [...responses];
  const mock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    calls.push({ url: url.toString(), method: init?.method, headers, body: init?.body });
    return queue.shift() ?? new Response("{}", { status: 500 });
  }) as unknown as typeof fetch;
  return { calls, mock };
}

describe("uploadDriveFile", () => {
  const originalFetch = globalThis.fetch;
  let tmpFile: string;

  beforeEach(async () => {
    mockGetUserAccessToken.mockReset();
    tmpFile = path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), "drive-test-")), "report.txt");
    await fs.promises.writeFile(tmpFile, "hello drive");
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    await fs.promises.rm(path.dirname(tmpFile), { recursive: true, force: true });
  });

  it("fails closed when the user has no OAuth grant", async () => {
    mockGetUserAccessToken.mockResolvedValue(null);
    const account = makeAccount();

    const result = await uploadDriveFile({ account, userId: "u-1", filePath: tmpFile });

    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("no OAuth grant"),
    });
  });

  it("registers metadata then uploads bytes — asserts each phase's URL/method/headers", async () => {
    mockGetUserAccessToken.mockResolvedValue({ token: "utok", scope: "file" });
    const account = makeAccount();
    const { calls, mock } = mockFetchSequence([
      new Response(JSON.stringify({ uploadUrl: "https://apis-storage.worksmobile.com/k1/abc", offset: 0 }), {
        status: 200,
      }),
      new Response(JSON.stringify({ fileId: "file-123", fileName: "report.txt" }), { status: 201 }),
    ]);
    globalThis.fetch = mock;

    const result = await uploadDriveFile({ account, userId: "u-1", filePath: tmpFile });

    expect(result).toEqual({ ok: true, fileId: "file-123", fileName: "report.txt" });
    expect(calls).toHaveLength(2);

    const phase1 = calls[0]!;
    expect(phase1.url).toBe("https://www.worksapis.com/v1.0/users/u-1/drive/files");
    expect(phase1.method).toBe("POST");
    expect(phase1.headers.authorization).toBe("Bearer utok");
    expect(phase1.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(phase1.body as string)).toEqual({
      fileName: "report.txt",
      fileSize: 11,
      overwrite: false,
    });

    const phase2 = calls[1]!;
    expect(phase2.url).toBe("https://apis-storage.worksmobile.com/k1/abc");
    expect(phase2.method).toBe("POST");
    expect(phase2.headers.authorization).toBe("Bearer utok");
    expect(phase2.body).toBeInstanceOf(FormData);
    const form = phase2.body as FormData;
    expect(form.get("resourceName")).toBe("report.txt");
    const fileEntry = form.get("FileData");
    expect(fileEntry).toBeInstanceOf(Blob);
    expect((fileEntry as File).name).toBe("report.txt");
  });

  it("registers under a parent folder when folderId is given", async () => {
    mockGetUserAccessToken.mockResolvedValue({ token: "utok" });
    const account = makeAccount();
    const { calls, mock } = mockFetchSequence([
      new Response(JSON.stringify({ uploadUrl: "https://apis-storage.worksmobile.com/k1/abc", offset: 0 }), {
        status: 200,
      }),
      new Response(JSON.stringify({ fileId: "file-123" }), { status: 201 }),
    ]);
    globalThis.fetch = mock;

    await uploadDriveFile({ account, userId: "u-1", filePath: tmpFile, folderId: "folder-9" });

    expect(calls[0]!.url).toBe("https://www.worksapis.com/v1.0/users/u-1/drive/files/folder-9");
  });

  it("phase-1 failure surfaces as ok:false and never calls phase 2", async () => {
    mockGetUserAccessToken.mockResolvedValue({ token: "utok" });
    const account = makeAccount();
    const { calls, mock } = mockFetchSequence([new Response("nope", { status: 403 })]);
    globalThis.fetch = mock;

    const result = await uploadDriveFile({ account, userId: "u-1", filePath: tmpFile });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("403");
    expect(calls).toHaveLength(1);
  });

  it("phase-2 failure surfaces as ok:false, not a silent success", async () => {
    mockGetUserAccessToken.mockResolvedValue({ token: "utok" });
    const account = makeAccount();
    const { calls, mock } = mockFetchSequence([
      new Response(JSON.stringify({ uploadUrl: "https://apis-storage.worksmobile.com/k1/abc", offset: 0 }), {
        status: 200,
      }),
      new Response("storage backend rejected bytes", { status: 500 }),
    ]);
    globalThis.fetch = mock;

    const result = await uploadDriveFile({ account, userId: "u-1", filePath: tmpFile });

    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("500"),
    });
    expect(calls).toHaveLength(2);
  });

  it("fails closed when the local file doesn't exist", async () => {
    mockGetUserAccessToken.mockResolvedValue({ token: "utok" });
    const account = makeAccount();

    const result = await uploadDriveFile({
      account,
      userId: "u-1",
      filePath: path.join(path.dirname(tmpFile), "missing.txt"),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("cannot read local file");
  });
});

describe("listDriveFiles", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockGetUserAccessToken.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("lists root folder children and maps summaries", async () => {
    mockGetUserAccessToken.mockResolvedValue({ token: "utok" });
    const account = makeAccount();
    const { calls, mock } = mockFetchSequence([
      new Response(
        JSON.stringify({
          files: [
            {
              fileId: "f-1",
              fileName: "works.txt",
              fileType: "DOC",
              fileSize: 10,
              filePath: "/works.txt",
              parentFileId: "root",
              createdTime: "2020-11-13T18:20:05.05+09:00",
              modifiedTime: "2021-04-05T21:14:05.05+09:00",
            },
          ],
          responseMetaData: { nextCursor: "" },
        }),
        { status: 200 },
      ),
    ]);
    globalThis.fetch = mock;

    const files = await listDriveFiles({ account, userId: "u-1" });

    expect(files).toEqual([
      {
        fileId: "f-1",
        fileName: "works.txt",
        fileType: "DOC",
        fileSize: 10,
        filePath: "/works.txt",
        parentFileId: "root",
        createdTime: "2020-11-13T18:20:05.05+09:00",
        modifiedTime: "2021-04-05T21:14:05.05+09:00",
      },
    ]);
    expect(calls[0]!.url).toBe("https://www.worksapis.com/v1.0/users/u-1/drive/files?count=20");
    expect(calls[0]!.headers.authorization).toBe("Bearer utok");
  });

  it("lists a specific folder's children when folderId is given", async () => {
    mockGetUserAccessToken.mockResolvedValue({ token: "utok" });
    const account = makeAccount();
    const { calls, mock } = mockFetchSequence([
      new Response(JSON.stringify({ files: [] }), { status: 200 }),
    ]);
    globalThis.fetch = mock;

    await listDriveFiles({ account, userId: "u-1", folderId: "folder-9", count: 50 });

    expect(calls[0]!.url).toBe(
      "https://www.worksapis.com/v1.0/users/u-1/drive/files/folder-9/children?count=50",
    );
  });

  it("returns null (not an empty list) on 403", async () => {
    mockGetUserAccessToken.mockResolvedValue({ token: "utok" });
    const account = makeAccount();
    const warnings: string[] = [];
    const { mock } = mockFetchSequence([new Response("forbidden", { status: 403 })]);
    globalThis.fetch = mock;

    const files = await listDriveFiles({
      account,
      userId: "u-1",
      log: { warn: (m) => warnings.push(m) },
    });

    expect(files).toBeNull();
    expect(files).not.toEqual([]);
    expect(warnings.join("\n")).toContain("403");
  });

  it("returns null when there's no OAuth grant", async () => {
    mockGetUserAccessToken.mockResolvedValue(null);
    const account = makeAccount();

    const files = await listDriveFiles({ account, userId: "u-1" });

    expect(files).toBeNull();
  });

  it("returns null on an unexpected response shape", async () => {
    mockGetUserAccessToken.mockResolvedValue({ token: "utok" });
    const account = makeAccount();
    const { mock } = mockFetchSequence([
      new Response(JSON.stringify({ files: [{ fileName: "no id" }] }), { status: 200 }),
    ]);
    globalThis.fetch = mock;

    const files = await listDriveFiles({ account, userId: "u-1" });

    expect(files).toBeNull();
  });
});

describe("createDriveShareLink", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockGetUserAccessToken.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("creates a share link and returns linkUrl", async () => {
    mockGetUserAccessToken.mockResolvedValue({ token: "utok" });
    const account = makeAccount();
    const { calls, mock } = mockFetchSequence([
      new Response(
        JSON.stringify({
          accessType: "SPECIFIC_PEOPLE",
          hasPassword: false,
          linkUrl: "https://works.do/xzO8Bv",
          createdTime: "2024-10-10T09:18:24+09:00",
          expirationTime: "2024-10-17T09:18:24+09:00",
          linkPermissionType: "EDIT",
          specificPeople: ["abc@example.com"],
        }),
        { status: 201 },
      ),
    ]);
    globalThis.fetch = mock;

    const result = await createDriveShareLink({
      account,
      userId: "u-1",
      fileId: "f-1",
      accessType: "SPECIFIC_PEOPLE",
      linkPermissionType: "EDIT",
      specificPeople: ["abc@example.com"],
    });

    expect(result).toEqual({
      ok: true,
      linkUrl: "https://works.do/xzO8Bv",
      expirationTime: "2024-10-17T09:18:24+09:00",
    });
    expect(calls[0]!.url).toBe("https://www.worksapis.com/v1.0/users/u-1/drive/files/f-1/link");
    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body as string)).toEqual({
      accessType: "SPECIFIC_PEOPLE",
      linkPermissionType: "EDIT",
      specificPeople: ["abc@example.com"],
    });
  });

  it("surfaces failure as ok:false, not a thrown error", async () => {
    mockGetUserAccessToken.mockResolvedValue({ token: "utok" });
    const account = makeAccount();
    const { mock } = mockFetchSequence([new Response("nope", { status: 400 })]);
    globalThis.fetch = mock;

    const result = await createDriveShareLink({
      account,
      userId: "u-1",
      fileId: "f-1",
      accessType: "ANYONE",
      linkPermissionType: "PREVIEW",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("400");
  });
});
