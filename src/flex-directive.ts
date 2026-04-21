/**
 * Parse LINE WORKS Flex-message directives out of an agent's text reply.
 *
 * Supported syntax (triple-pipe `|||` separator so JSON commas/pipes are safe):
 *
 *   [[flex: <altText> ||| <JSON>]]
 *
 * The JSON is the `contents` payload — either a bubble object or a carousel
 * (`{ type: "bubble", ... }` / `{ type: "carousel", contents: [bubble, ...] }`).
 * Everything outside the directive remains the text portion of the reply.
 *
 * Multiple `[[flex: ... ]]` directives in one message are all extracted.
 */
import type { LineWorksOutboundFlexMessage } from "./types.js";

const FLEX_RE = /\[\[flex:\s*([\s\S]*?)\]\]/g;
const SEP = "|||";

export interface ExtractedFlex {
  messages: LineWorksOutboundFlexMessage[];
  residualText: string;
  parseErrors: string[];
}

export function extractFlexDirectives(text: string): ExtractedFlex {
  if (!text || !text.includes("[[flex:")) {
    return { messages: [], residualText: text, parseErrors: [] };
  }

  const messages: LineWorksOutboundFlexMessage[] = [];
  const parseErrors: string[] = [];

  const residualText = text
    .replace(FLEX_RE, (_match, inner: string) => {
      const parsed = parseOneFlex(inner);
      if (parsed.ok) {
        messages.push(parsed.message);
      } else {
        parseErrors.push(parsed.reason);
      }
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { messages, residualText, parseErrors };
}

function parseOneFlex(
  inner: string,
): { ok: true; message: LineWorksOutboundFlexMessage } | { ok: false; reason: string } {
  const sepIdx = inner.indexOf(SEP);
  if (sepIdx < 0) {
    return {
      ok: false,
      reason: `flex directive missing "${SEP}" separator between altText and JSON`,
    };
  }
  const altText = inner.slice(0, sepIdx).trim();
  const jsonSource = inner.slice(sepIdx + SEP.length).trim();
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
