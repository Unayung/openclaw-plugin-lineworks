import fs from "node:fs";
import path from "node:path";
import { buildRandomTempFilePath } from "openclaw/plugin-sdk/temp-path";
import { getAccessToken } from "./auth.js";
import type { ResolvedLineWorksAccount } from "./types.js";

const LINEWORKS_API_BASE = "https://www.worksapis.com/v1.0";
const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;

export interface LineWorksAttachmentDownload {
  path: string;
  contentType: string;
  size: number;
}

function extensionFor(contentType: string): string {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base.startsWith("image/jpeg")) return "jpg";
  if (base.startsWith("image/png")) return "png";
  if (base.startsWith("image/gif")) return "gif";
  if (base.startsWith("image/webp")) return "webp";
  if (base.startsWith("image/heic")) return "heic";
  if (base.startsWith("video/mp4")) return "mp4";
  if (base.startsWith("audio/mpeg")) return "mp3";
  if (base.startsWith("audio/mp4") || base.startsWith("audio/m4a")) return "m4a";
  if (base.startsWith("audio/wav")) return "wav";
  if (base.startsWith("application/pdf")) return "pdf";
  return "bin";
}

/**
 * Download a LINE WORKS bot attachment (image / file / video / audio) to a
 * temp file. The bot must have access to the attachment's resourceId (it was
 * sent to this bot via a webhook event).
 *
 * Endpoint: GET /v1.0/bots/{botId}/attachments/{resourceId}
 * Returns binary content; the bot access token is attached as a bearer token.
 */
export async function downloadLineWorksAttachment(args: {
  account: ResolvedLineWorksAccount;
  resourceId: string;
  maxBytes?: number;
}): Promise<LineWorksAttachmentDownload> {
  const { account, resourceId } = args;
  const maxBytes = args.maxBytes ?? DEFAULT_MAX_BYTES;

  const access = await getAccessToken(account);
  const url = `${LINEWORKS_API_BASE}/bots/${encodeURIComponent(
    account.botId,
  )}/attachments/${encodeURIComponent(resourceId)}`;

  // The initial endpoint returns a 302 redirect to a signed CDN URL. Node's
  // fetch strips `Authorization` on cross-origin redirects, so we follow the
  // redirect manually and keep the Bearer token on the second hop (LINE WORKS
  // expects it — confirmed via their docs + community samples).
  const headers = { authorization: `${access.tokenType} ${access.token}` };
  const initial = await fetch(url, { method: "GET", headers, redirect: "manual" });

  let finalResponse: Response;
  if (initial.status >= 300 && initial.status < 400) {
    const location = initial.headers.get("location");
    if (!location) {
      throw new Error(
        `LINE WORKS attachment fetch: ${initial.status} redirect without Location header`,
      );
    }
    finalResponse = await fetch(location, { method: "GET", headers, redirect: "follow" });
  } else {
    finalResponse = initial;
  }

  if (!finalResponse.ok) {
    const text = await finalResponse.text().catch(() => "");
    const scopeHint = access.scope
      ? ` (token was granted scope: "${access.scope}")`
      : " (no scope in token response — likely granted only the minimum your app permits)";
    throw new Error(
      `LINE WORKS attachment fetch failed: ${finalResponse.status} ${text}${scopeHint}`,
    );
  }

  const contentType = finalResponse.headers.get("content-type") ?? "application/octet-stream";
  const buf = Buffer.from(await finalResponse.arrayBuffer());
  if (buf.byteLength > maxBytes) {
    throw new Error(
      `LINE WORKS attachment ${resourceId} exceeds max size (${buf.byteLength} > ${maxBytes})`,
    );
  }

  const ext = extensionFor(contentType);
  const outPath = buildRandomTempFilePath({ prefix: "lineworks-media", extension: ext });
  await fs.promises.writeFile(outPath, buf);

  return { path: outPath, contentType, size: buf.byteLength };
}

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "heic") return "image/heic";
  if (ext === "mp4") return "video/mp4";
  if (ext === "mp3") return "audio/mpeg";
  if (ext === "m4a") return "audio/mp4";
  if (ext === "pdf") return "application/pdf";
  return "application/octet-stream";
}

/**
 * Upload a local file to LINE WORKS so it can be referenced by fileId in
 * outbound messages. Two-step flow:
 *   1. POST /v1.0/bots/{botId}/attachments  body={fileName}  → {uploadUrl, fileId}
 *   2. POST uploadUrl  multipart/form-data (FileData, resourceName)
 */
export async function uploadLineWorksAttachment(args: {
  account: ResolvedLineWorksAccount;
  filePath: string;
  fileName?: string;
}): Promise<{ fileId: string; fileName: string }> {
  const { account } = args;
  const resolvedFileName = args.fileName ?? path.basename(args.filePath);
  const access = await getAccessToken(account);

  // Step 1 — request an upload URL
  const step1 = await fetch(
    `${LINEWORKS_API_BASE}/bots/${encodeURIComponent(account.botId)}/attachments`,
    {
      method: "POST",
      headers: {
        authorization: `${access.tokenType} ${access.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ fileName: resolvedFileName }),
    },
  );
  if (!step1.ok) {
    const text = await step1.text().catch(() => "");
    throw new Error(`LINE WORKS upload init failed: ${step1.status} ${text}`);
  }
  const init = (await step1.json()) as { uploadUrl: string; fileId: string };

  // Step 2 — POST the binary to the returned uploadUrl
  const bytes = await fs.promises.readFile(args.filePath);
  const form = new FormData();
  form.append(
    "FileData",
    new Blob([new Uint8Array(bytes)], { type: mimeFor(args.filePath) }),
    resolvedFileName,
  );
  form.append("resourceName", resolvedFileName);
  const step2 = await fetch(init.uploadUrl, {
    method: "POST",
    headers: { authorization: `${access.tokenType} ${access.token}` },
    body: form,
  });
  if (!step2.ok) {
    const text = await step2.text().catch(() => "");
    throw new Error(`LINE WORKS upload bytes failed: ${step2.status} ${text}`);
  }

  return { fileId: init.fileId, fileName: resolvedFileName };
}

export function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/**
 * Map an HTTP Content-Type to the LINE WORKS message kind this plugin uses.
 * Used as a fallback when an HTTPS URL has no (recognizable) extension on its
 * path — e.g. `https://picsum.photos/id/237/400/300` returns a JPEG but the
 * path doesn't end in `.jpg`, so we'd otherwise misfile it as a generic file.
 */
export function mediaKindForContentType(
  ct: string,
): "image" | "video" | "audio" | "file" {
  const base = (ct.split(";")[0] ?? "").trim().toLowerCase();
  if (base.startsWith("image/")) return "image";
  if (base.startsWith("video/")) return "video";
  if (base.startsWith("audio/")) return "audio";
  return "file";
}

/**
 * Download an HTTPS URL to a temp file and return the local path. Used when
 * outbound media is referenced by URL but LINE WORKS needs an uploaded fileId
 * (e.g., video, audio, and generic file attachments that LINE WORKS cannot
 * consume as a bare URL).
 *
 * The extension is inferred from the URL path and then from Content-Type as
 * a fallback so the upload + fileId-message path can pick the right shape.
 */
export async function downloadHttpsToTempFile(
  url: string,
  maxBytes = 50 * 1024 * 1024,
): Promise<{ path: string; contentType: string; size: number; fileName: string }> {
  const res = await fetch(url, { method: "GET", redirect: "follow" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`download failed: ${res.status} ${text.slice(0, 120)}`);
  }
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) {
    throw new Error(`downloaded file exceeds ${maxBytes} bytes (${buf.byteLength})`);
  }
  // Prefer extension from URL pathname; fall back to content-type guess.
  const urlExt = (new URL(url).pathname.split(".").pop() ?? "").toLowerCase();
  const isKnownExt = /^[a-z0-9]{1,5}$/.test(urlExt);
  const ext = isKnownExt ? urlExt : extensionFor(contentType);
  const fileName =
    (new URL(url).pathname.split("/").pop() || "download").replace(/[^\w.\-]/g, "_") || `media.${ext}`;
  const outPath = buildRandomTempFilePath({ prefix: "lineworks-download", extension: ext });
  await fs.promises.writeFile(outPath, buf);
  return { path: outPath, contentType, size: buf.byteLength, fileName };
}
