import fs from "node:fs";
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
  const path = buildRandomTempFilePath({ prefix: "lineworks-media", extension: ext });
  await fs.promises.writeFile(path, buf);

  return { path, contentType, size: buf.byteLength };
}
