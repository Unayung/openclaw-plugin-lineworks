import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  LineWorksInboundContent,
  LineWorksInboundEvent,
  LineWorksInboundSource,
  ResolvedLineWorksAccount,
} from "./types.js";

export const LINEWORKS_SIGNATURE_HEADER = "x-works-signature";
export const LINEWORKS_BOT_ID_HEADER = "x-works-botid";

// LINE WORKS signs the raw request body with HMAC-SHA256 using the bot secret
// and sends the base64-encoded digest in the `X-WORKS-Signature` header.
// Length-check first (cheap, secret-independent) and then `timingSafeEqual`.
//
// IMPORTANT: `rawBody` must be the exact bytes LINE WORKS sent. If you parse
// with `express.json()` and then re-serialize via `JSON.stringify(req.body)`,
// any key ordering or whitespace difference will make verification fail. Use
// `express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } })` or
// `express.raw({ type: "application/json" })` to capture the original buffer.
export function verifySignature(args: {
  rawBody: Buffer | string;
  signatureHeader: string | undefined;
  botSecret: string;
}): boolean {
  if (!args.signatureHeader || !args.botSecret) return false;

  const body =
    typeof args.rawBody === "string" ? Buffer.from(args.rawBody, "utf8") : args.rawBody;
  const expected = createHmac("sha256", args.botSecret).update(body).digest();

  let got: Buffer;
  try {
    got = Buffer.from(args.signatureHeader, "base64");
  } catch {
    return false;
  }
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

export function parseInboundEvent(raw: unknown): LineWorksInboundEvent | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : undefined;
  if (!type) return undefined;

  const source = extractSource(obj.source);
  if (!source) return undefined;

  const receivedAt = Date.now();
  const content = extractContent(obj.content);

  switch (type) {
    case "message":
      return {
        kind: source.type === "user" ? "user-message" : "channel-message",
        source,
        content,
        raw,
        receivedAt,
      };
    case "join":
      return { kind: "bot-joined", source, raw, receivedAt };
    case "leave":
      return { kind: "bot-left", source, raw, receivedAt };
    case "memberJoined":
      return { kind: "member-joined", source, raw, receivedAt };
    case "memberLeft":
      return { kind: "member-left", source, raw, receivedAt };
    case "postback":
      return { kind: "postback", source, content, raw, receivedAt };
    default:
      return { kind: "unknown", source, raw, receivedAt };
  }
}

function extractSource(raw: unknown): LineWorksInboundSource | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as Record<string, unknown>;
  const userId = typeof s.userId === "string" ? s.userId : undefined;
  const channelId = typeof s.channelId === "string" ? s.channelId : undefined;
  const domainId =
    typeof s.domainId === "string"
      ? s.domainId
      : typeof s.domainId === "number"
        ? String(s.domainId)
        : undefined;

  if (channelId) return { type: "channel", channelId, userId, domainId };
  if (userId) return { type: "user", userId, domainId };
  return undefined;
}

function extractContent(raw: unknown): LineWorksInboundContent | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  const type = typeof c.type === "string" ? c.type : undefined;
  switch (type) {
    case "text":
      return typeof c.text === "string" ? { type: "text", text: c.text } : undefined;
    case "image": {
      // LINE WORKS payload uses `fileId`; keep `resourceId` as a fallback.
      const id = typeof c.fileId === "string" ? c.fileId
        : typeof c.resourceId === "string" ? c.resourceId
        : undefined;
      return id ? { type: "image", resourceId: id } : undefined;
    }
    case "file": {
      const id = typeof c.fileId === "string" ? c.fileId
        : typeof c.resourceId === "string" ? c.resourceId
        : undefined;
      return id
        ? {
            type: "file",
            resourceId: id,
            fileName: typeof c.fileName === "string" ? c.fileName : undefined,
          }
        : undefined;
    }
    case "sticker":
      return typeof c.packageId === "string" && typeof c.stickerId === "string"
        ? { type: "sticker", packageId: c.packageId, stickerId: c.stickerId }
        : undefined;
    case "location":
      return typeof c.latitude === "number" && typeof c.longitude === "number"
        ? {
            type: "location",
            title: typeof c.title === "string" ? c.title : undefined,
            latitude: c.latitude,
            longitude: c.longitude,
          }
        : undefined;
    default:
      if (typeof c.postback === "string") return { type: "postback", data: c.postback };
      return undefined;
  }
}

export function resolveDomain(account: ResolvedLineWorksAccount): string | undefined {
  return account.domainId ?? account.config.domainId;
}
