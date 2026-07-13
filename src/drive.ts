import fs from "node:fs";
import path from "node:path";
import { getUserAccessToken } from "./oauth.js";
import type { ResolvedLineWorksAccount } from "./types.js";

/**
 * LINE WORKS Drive API — personal "My Drive" only (scope `file` / `file.read`).
 *
 * Verified against developers.worksmobile.com/jp/docs/drive (and children
 * drive-file-create, drive-file-root-create, drive-file-list,
 * drive-file-root-list, drive-file-link-create, file-upload). Full verbatim
 * request/response shapes: see the spec written alongside this module.
 *
 * IMPORTANT: unlike bot messaging (auth.ts's service-account JWT), the Drive
 * API explicitly rejects Service Account tokens — "Drive API は、User Account
 * 認証で取得した Access Token で利用できます。Service Account 認証 (JWT) で
 * 取得した Token では利用できません。" Every call here goes through
 * `getUserAccessToken` (per-user OAuth); there is no service-account fallback.
 *
 * Honesty contract: reads return `null` on any failure (never a fake empty
 * array); writes return `{ok:false, reason}` on any failure, including a
 * failure at the *second* phase of the two-phase upload (metadata OK but
 * bytes rejected is still a failure, not a partial success).
 */

const LINEWORKS_API_BASE = "https://www.worksapis.com/v1.0";

export type LineWorksDriveFileType =
  | "AUDIO"
  | "DOC"
  | "ETC"
  | "EXE"
  | "FOLDER"
  | "IMAGE"
  | "VIDEO"
  | "ZIP";

export interface LineWorksDriveFileSummary {
  fileId: string;
  fileName: string;
  fileType?: LineWorksDriveFileType;
  fileSize?: number;
  filePath?: string;
  parentFileId?: string;
  createdTime?: string;
  modifiedTime?: string;
}

export type LineWorksUploadDriveFileResult =
  | { ok: true; fileId: string; fileName?: string }
  | { ok: false; reason: string };

type DriveLog = { warn?: (msg: string) => void };

/**
 * Minimal extension→MIME lookup for report-shaped files agents park in
 * Drive. Falls back to `application/octet-stream`, which LINE WORKS accepts
 * (it does not reject uploads on Content-Type mismatch).
 */
function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  switch (ext) {
    case "txt":
      return "text/plain";
    case "md":
      return "text/markdown";
    case "csv":
      return "text/csv";
    case "json":
      return "application/json";
    case "html":
      return "text/html";
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "zip":
      return "application/zip";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    default:
      return "application/octet-stream";
  }
}

/**
 * Upload a local file into the given user's personal Drive ("My Drive").
 * Two-phase flow (same shape as attachments.ts's bot-attachment upload, but
 * verified separately for Drive — see spec):
 *   1. POST /v1.0/users/{userId}/drive/files[/{folderId}]  body={fileName,fileSize,overwrite}
 *      → {uploadUrl, offset}
 *   2. POST {uploadUrl}  multipart/form-data (FileData, resourceName)
 *
 * Fails closed at every phase: missing/expired OAuth grant, unreadable local
 * file, phase-1 HTTP error, phase-1 response missing `uploadUrl`, phase-2 HTTP
 * error, or phase-2 response missing `fileId` — all return `{ok:false,
 * reason}`. A phase-2 failure after a successful phase-1 is still a failure,
 * never reported as success.
 */
export async function uploadDriveFile(args: {
  account: ResolvedLineWorksAccount;
  userId: string;
  filePath: string;
  fileName?: string;
  /** Parent folder's Drive fileId. Omit to upload into the root of My Drive. */
  folderId?: string;
  /** Overwrite an existing file with the same name. Default false. */
  overwrite?: boolean;
  log?: DriveLog;
}): Promise<LineWorksUploadDriveFileResult> {
  const { account, userId, filePath } = args;
  const fileName = args.fileName ?? path.basename(filePath);
  const warn = (reason: string) => {
    args.log?.warn?.(`LINE WORKS uploadDriveFile(${userId}) failed: ${reason}`);
    return { ok: false as const, reason };
  };

  try {
    const access = await getUserAccessToken({ account, userId, log: args.log });
    if (!access) {
      return warn("no OAuth grant for this user (per-user OAuth is required for Drive)");
    }

    let fileSize: number;
    try {
      const stat = await fs.promises.stat(filePath);
      fileSize = stat.size;
    } catch (err) {
      return warn(`cannot read local file: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Phase 1 — register metadata, get an upload URL.
    const registerUrl = args.folderId
      ? `${LINEWORKS_API_BASE}/users/${encodeURIComponent(userId)}/drive/files/${encodeURIComponent(args.folderId)}`
      : `${LINEWORKS_API_BASE}/users/${encodeURIComponent(userId)}/drive/files`;
    const step1 = await fetch(registerUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${access.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        fileName,
        fileSize,
        overwrite: args.overwrite ?? false,
      }),
    });
    if (!step1.ok) {
      const text = await step1.text().catch(() => "");
      return warn(`phase 1 (register) ${step1.status} ${text.slice(0, 200)}`);
    }
    const init = (await step1.json().catch(() => ({}))) as { uploadUrl?: string };
    if (!init.uploadUrl) {
      return warn("phase 1 response missing uploadUrl");
    }

    // Phase 2 — POST the binary to the returned uploadUrl.
    const bytes = await fs.promises.readFile(filePath);
    const form = new FormData();
    form.append("FileData", new Blob([new Uint8Array(bytes)], { type: mimeFor(filePath) }), fileName);
    form.append("resourceName", fileName);
    const step2 = await fetch(init.uploadUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${access.token}` },
      body: form,
    });
    if (!step2.ok) {
      const text = await step2.text().catch(() => "");
      return warn(`phase 2 (upload bytes) ${step2.status} ${text.slice(0, 200)}`);
    }
    const result = (await step2.json().catch(() => ({}))) as {
      fileId?: string;
      fileName?: string;
    };
    if (!result.fileId) {
      return warn("phase 2 response missing fileId");
    }

    return { ok: true, fileId: result.fileId, fileName: result.fileName ?? fileName };
  } catch (err) {
    return warn(err instanceof Error ? err.message : String(err));
  }
}

/**
 * List files/folders directly under a folder in the given user's personal
 * Drive. Omit `folderId` to list the root of My Drive.
 *
 * Endpoint: GET /v1.0/users/{userId}/drive/files[/{folderId}]/children (root
 * variant omits the `{folderId}`+`/children` segment entirely — see spec).
 * Scope: `file` or `file.read`.
 *
 * Fails CLOSED: missing/expired OAuth grant, HTTP error, or unexpected
 * response shape all return `null` — never an empty array a caller could
 * mistake for a real empty folder. Only a single page is fetched (`count`,
 * default 20, max 200) — no auto-pagination.
 */
export async function listDriveFiles(args: {
  account: ResolvedLineWorksAccount;
  userId: string;
  folderId?: string;
  count?: number;
  log?: DriveLog;
}): Promise<LineWorksDriveFileSummary[] | null> {
  const { account, userId } = args;
  const warn = (reason: string) => {
    args.log?.warn?.(`LINE WORKS listDriveFiles(${userId}) failed: ${reason}`);
    return null;
  };

  try {
    const access = await getUserAccessToken({ account, userId, log: args.log });
    if (!access) {
      return warn("no OAuth grant for this user (per-user OAuth is required for Drive)");
    }

    const base = args.folderId
      ? `${LINEWORKS_API_BASE}/users/${encodeURIComponent(userId)}/drive/files/${encodeURIComponent(args.folderId)}/children`
      : `${LINEWORKS_API_BASE}/users/${encodeURIComponent(userId)}/drive/files`;
    const url = new URL(base);
    const count = Math.min(200, Math.max(1, args.count ?? 20));
    url.searchParams.set("count", String(count));

    const res = await fetch(url, {
      headers: { authorization: `Bearer ${access.token}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return warn(`${res.status} ${text.slice(0, 200)}`);
    }

    const json = (await res.json().catch(() => null)) as { files?: unknown } | null;
    if (!json || !Array.isArray(json.files)) {
      return warn("unexpected response shape (files is not an array)");
    }

    const files: LineWorksDriveFileSummary[] = [];
    for (const raw of json.files) {
      if (typeof raw !== "object" || raw === null) return warn("unexpected file entry shape");
      const f = raw as Record<string, unknown>;
      if (typeof f["fileId"] !== "string" || typeof f["fileName"] !== "string") {
        return warn("file entry missing fileId/fileName");
      }
      files.push({
        fileId: f["fileId"],
        fileName: f["fileName"],
        fileType: typeof f["fileType"] === "string" ? (f["fileType"] as LineWorksDriveFileType) : undefined,
        fileSize: typeof f["fileSize"] === "number" ? f["fileSize"] : undefined,
        filePath: typeof f["filePath"] === "string" ? f["filePath"] : undefined,
        parentFileId: typeof f["parentFileId"] === "string" ? f["parentFileId"] : undefined,
        createdTime: typeof f["createdTime"] === "string" ? f["createdTime"] : undefined,
        modifiedTime: typeof f["modifiedTime"] === "string" ? f["modifiedTime"] : undefined,
      });
    }
    return files;
  } catch (err) {
    return warn(err instanceof Error ? err.message : String(err));
  }
}

export type LineWorksDriveLinkAccessType = "ORGANIZATION" | "SPECIFIC_PEOPLE" | "ANYONE";
export type LineWorksDriveLinkPermissionType =
  | "EDIT"
  | "UPLOAD_DOWNLOAD"
  | "UPLOAD"
  | "DOWNLOAD"
  | "PREVIEW";

export type LineWorksCreateDriveShareLinkResult =
  | { ok: true; linkUrl: string; expirationTime?: string }
  | { ok: false; reason: string };

/**
 * Create a share link for a file/folder in the given user's personal Drive.
 *
 * Endpoint: POST /v1.0/users/{userId}/drive/files/{fileId}/link
 * Scope:    `file`
 *
 * Verified to exist and NOT be admin-gated: it's listed under "My Drive" on
 * LINE WORKS's own docs nav and uses the same per-user `file` OAuth scope as
 * upload/list — see spec's "Share link — verified to EXIST" section.
 *
 * `accessType` and `linkPermissionType` are required (no default): the API
 * itself requires both, and `accessType:"ANYONE"` makes the link public, so
 * this module refuses to silently pick a default on the caller's behalf.
 */
export async function createDriveShareLink(args: {
  account: ResolvedLineWorksAccount;
  userId: string;
  fileId: string;
  accessType: LineWorksDriveLinkAccessType;
  linkPermissionType: LineWorksDriveLinkPermissionType;
  /** ISO-8601. Omit for a link that never expires. */
  expirationTime?: string;
  /** Only valid when accessType is "ANYONE". 4-16 chars. */
  password?: string;
  /** Only valid when accessType is "SPECIFIC_PEOPLE". */
  specificPeople?: string[];
  log?: DriveLog;
}): Promise<LineWorksCreateDriveShareLinkResult> {
  const { account, userId, fileId } = args;
  const warn = (reason: string) => {
    args.log?.warn?.(`LINE WORKS createDriveShareLink(${userId}, ${fileId}) failed: ${reason}`);
    return { ok: false as const, reason };
  };

  try {
    const access = await getUserAccessToken({ account, userId, log: args.log });
    if (!access) {
      return warn("no OAuth grant for this user (per-user OAuth is required for Drive)");
    }

    const url = `${LINEWORKS_API_BASE}/users/${encodeURIComponent(userId)}/drive/files/${encodeURIComponent(fileId)}/link`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${access.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        accessType: args.accessType,
        linkPermissionType: args.linkPermissionType,
        ...(args.expirationTime ? { expirationTime: args.expirationTime } : {}),
        ...(args.password ? { password: args.password } : {}),
        ...(args.specificPeople ? { specificPeople: args.specificPeople } : {}),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return warn(`${res.status} ${text.slice(0, 200)}`);
    }
    const json = (await res.json().catch(() => ({}))) as {
      linkUrl?: string;
      expirationTime?: string;
    };
    if (!json.linkUrl) {
      return warn("response missing linkUrl");
    }
    return { ok: true, linkUrl: json.linkUrl, expirationTime: json.expirationTime };
  } catch (err) {
    return warn(err instanceof Error ? err.message : String(err));
  }
}
