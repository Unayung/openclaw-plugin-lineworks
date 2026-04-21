/**
 * Parse LINE WORKS message directives out of an agent's text reply.
 *
 * Supported syntax:
 *
 *   [[flex: <altText> ||| <JSON>]]
 *     Rich card (LINE Flex format — bubble or carousel).
 *
 *   [[location: <title> | <address> | <lat> | <lng>]]
 *     Pinned location message.
 *
 *   [[quick_replies: <label1>, <label2>, <label3>]]
 *     Tap-chips that appear under the previous message. Each label either:
 *       - `text` (default, sends the label itself as user reply)
 *       - `label > https://url.example` (opens the URL)
 *       - `label > data:<postback payload>` (returns postback event)
 *
 * All directives may appear anywhere in the text; the surrounding text is sent
 * as a separate text message. Multiple flex/location directives are allowed;
 * only the first quick_replies directive is honored (LINE WORKS attaches one
 * set of quick replies to the message they accompany).
 */
import type {
  LineWorksOutboundFlexMessage,
  LineWorksOutboundLocationMessage,
  LineWorksQuickReply,
  LineWorksQuickReplyItem,
} from "./types.js";

const FLEX_RE = /\[\[flex:\s*([\s\S]*?)\]\]/g;
const LOCATION_RE = /\[\[location:\s*([\s\S]*?)\]\]/g;
const QUICK_RE = /\[\[quick_replies:\s*([\s\S]*?)\]\]/g;
const FLEX_SEP = "|||";

export interface ExtractedDirectives {
  flex: LineWorksOutboundFlexMessage[];
  locations: LineWorksOutboundLocationMessage[];
  quickReply: LineWorksQuickReply | undefined;
  residualText: string;
  parseErrors: string[];
}

export function extractDirectives(text: string): ExtractedDirectives {
  if (!text) {
    return { flex: [], locations: [], quickReply: undefined, residualText: text, parseErrors: [] };
  }

  const flex: LineWorksOutboundFlexMessage[] = [];
  const locations: LineWorksOutboundLocationMessage[] = [];
  const parseErrors: string[] = [];
  let quickReply: LineWorksQuickReply | undefined;

  let residualText = text;

  residualText = residualText.replace(FLEX_RE, (_m, inner: string) => {
    const parsed = parseFlex(inner);
    if (parsed.ok) flex.push(parsed.message);
    else parseErrors.push(parsed.reason);
    return "";
  });

  residualText = residualText.replace(LOCATION_RE, (_m, inner: string) => {
    const parsed = parseLocation(inner);
    if (parsed.ok) locations.push(parsed.message);
    else parseErrors.push(parsed.reason);
    return "";
  });

  residualText = residualText.replace(QUICK_RE, (_m, inner: string) => {
    const parsed = parseQuickReplies(inner);
    if (parsed.ok && !quickReply) quickReply = parsed.quickReply;
    else if (!parsed.ok) parseErrors.push(parsed.reason);
    return "";
  });

  residualText = residualText
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { flex, locations, quickReply, residualText, parseErrors };
}

// ---- parsers -------------------------------------------------------------

function parseFlex(
  inner: string,
): { ok: true; message: LineWorksOutboundFlexMessage } | { ok: false; reason: string } {
  const sepIdx = inner.indexOf(FLEX_SEP);
  if (sepIdx < 0) {
    return {
      ok: false,
      reason: `flex directive missing "${FLEX_SEP}" separator between altText and JSON`,
    };
  }
  const altText = inner.slice(0, sepIdx).trim();
  const jsonSource = inner.slice(sepIdx + FLEX_SEP.length).trim();
  if (!altText) return { ok: false, reason: "flex directive has empty altText" };
  if (!jsonSource) return { ok: false, reason: "flex directive has empty contents JSON" };

  let contents: unknown;
  try {
    contents = JSON.parse(jsonSource);
  } catch (err) {
    return {
      ok: false,
      reason: `flex directive JSON parse failed: ${(err as Error).message}`,
    };
  }
  if (!contents || typeof contents !== "object" || Array.isArray(contents)) {
    return { ok: false, reason: "flex directive contents must be a JSON object" };
  }

  return {
    ok: true,
    message: {
      type: "flex",
      altText: altText.slice(0, 400),
      contents: contents as Record<string, unknown>,
    },
  };
}

function parseLocation(
  inner: string,
): { ok: true; message: LineWorksOutboundLocationMessage } | { ok: false; reason: string } {
  // title | address | lat | lng
  const parts = inner.split("|").map((p) => p.trim());
  if (parts.length !== 4) {
    return {
      ok: false,
      reason: 'location directive expects "<title> | <address> | <lat> | <lng>"',
    };
  }
  const [title, address, latStr, lngStr] = parts;
  const latitude = Number(latStr);
  const longitude = Number(lngStr);
  if (!title || !address) {
    return { ok: false, reason: "location directive missing title or address" };
  }
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return {
      ok: false,
      reason: `location directive has non-numeric lat/lng (got "${latStr}", "${lngStr}")`,
    };
  }
  return {
    ok: true,
    message: {
      type: "location",
      title: title.slice(0, 100),
      address: address.slice(0, 100),
      latitude,
      longitude,
    },
  };
}

function parseQuickReplies(
  inner: string,
): { ok: true; quickReply: LineWorksQuickReply } | { ok: false; reason: string } {
  const labels = inner
    .split(",")
    .map((raw) => raw.trim())
    .filter(Boolean);
  if (labels.length === 0) {
    return { ok: false, reason: "quick_replies directive has no labels" };
  }
  if (labels.length > 13) {
    return { ok: false, reason: `quick_replies directive has >13 labels (${labels.length})` };
  }
  const items: LineWorksQuickReplyItem[] = labels.map((raw) => {
    const arrowIdx = raw.indexOf(">");
    if (arrowIdx < 0) {
      return { action: { type: "message", label: raw.slice(0, 20), text: raw } };
    }
    const label = raw.slice(0, arrowIdx).trim();
    const target = raw.slice(arrowIdx + 1).trim();
    if (/^https?:\/\//i.test(target)) {
      return { action: { type: "uri", label: label.slice(0, 20), uri: target } };
    }
    if (target.toLowerCase().startsWith("data:")) {
      return {
        action: {
          type: "postback",
          label: label.slice(0, 20),
          data: target.slice("data:".length),
          displayText: label,
        },
      };
    }
    // Fallback: treat remainder as the text to send.
    return { action: { type: "message", label: label.slice(0, 20), text: target } };
  });
  return { ok: true, quickReply: { items } };
}
