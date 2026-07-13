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
 *   [[mail_send:
 *   to: a@b.com, c@b.com
 *   cc: d@b.com
 *   subject: Hello
 *   body:
 *   Free-form body, multi-line, runs to the closing ]].
 *   ]]
 *     Send a mail via LINE WORKS Mail API. Requires `mail` scope + the bot
 *     identity having send permission for the `from` mailbox. Body starts on
 *     the line after `body:` and continues to the close brackets.
 *
 *   [[calendar_create:
 *   summary: Quarterly sync
 *   start: 2026-07-15T14:00:00
 *   end: 2026-07-15T15:00:00
 *   timezone: Asia/Taipei
 *   location: Room A
 *   attendees: a@b.com, c@b.com
 *   description:
 *   Free-form description, multi-line, runs to the closing ]].
 *   ]]
 *     Create an event in the sender's default calendar (per-user OAuth,
 *     `calendar` scope). summary/start/end/timezone are required; timezone is
 *     an IANA name and start/end are bare local timestamps (no UTC offset —
 *     LINE WORKS carries the zone separately). location/attendees/description
 *     are optional; description is the last field, multi-line.
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
const MAIL_RE = /\[\[mail_send:\s*([\s\S]*?)\]\]/g;
const CALENDAR_RE = /\[\[calendar_create:\s*([\s\S]*?)\]\]/g;
const FLEX_SEP = "|||";

export interface MailSendDirective {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
}

export interface CalendarCreateDirective {
  summary: string;
  /** Bare local timestamp `YYYY-MM-DDTHH:mm:ss` (no offset). */
  start: string;
  end: string;
  /** IANA timezone name, e.g. "Asia/Taipei". */
  timeZone: string;
  location?: string;
  attendeeEmails?: string[];
  description?: string;
}

export interface ExtractedDirectives {
  flex: LineWorksOutboundFlexMessage[];
  locations: LineWorksOutboundLocationMessage[];
  quickReply: LineWorksQuickReply | undefined;
  mailSends: MailSendDirective[];
  calendarCreates: CalendarCreateDirective[];
  residualText: string;
  parseErrors: string[];
}

export function extractDirectives(text: string): ExtractedDirectives {
  if (!text) {
    return {
      flex: [],
      locations: [],
      quickReply: undefined,
      mailSends: [],
      calendarCreates: [],
      residualText: text,
      parseErrors: [],
    };
  }

  const flex: LineWorksOutboundFlexMessage[] = [];
  const locations: LineWorksOutboundLocationMessage[] = [];
  const mailSends: MailSendDirective[] = [];
  const calendarCreates: CalendarCreateDirective[] = [];
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

  residualText = residualText.replace(MAIL_RE, (_m, inner: string) => {
    const parsed = parseMailSend(inner);
    if (parsed.ok) mailSends.push(parsed.directive);
    else parseErrors.push(parsed.reason);
    return "";
  });

  residualText = residualText.replace(CALENDAR_RE, (_m, inner: string) => {
    const parsed = parseCalendarCreate(inner);
    if (parsed.ok) calendarCreates.push(parsed.directive);
    else parseErrors.push(parsed.reason);
    return "";
  });

  residualText = residualText
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { flex, locations, quickReply, mailSends, calendarCreates, residualText, parseErrors };
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

function splitEmails(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseMailSend(
  inner: string,
): { ok: true; directive: MailSendDirective } | { ok: false; reason: string } {
  // `body:` is the boundary — everything after (to the end of the directive)
  // is the body, verbatim. Everything before is parsed line-by-line as
  // `key: value`.
  const bodyMarker = /(^|\n)\s*body\s*:/i.exec(inner);
  let headerPart: string;
  let body = "";
  if (bodyMarker) {
    headerPart = inner.slice(0, bodyMarker.index);
    body = inner.slice(bodyMarker.index + bodyMarker[0].length).replace(/^\n/, "").trim();
  } else {
    headerPart = inner;
  }

  let to: string[] = [];
  let cc: string[] = [];
  let bcc: string[] = [];
  let subject = "";
  for (const line of headerPart.split(/\r?\n/)) {
    const m = /^\s*(to|cc|bcc|subject)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = (m[2] ?? "").trim();
    if (key === "to") to = splitEmails(val);
    else if (key === "cc") cc = splitEmails(val);
    else if (key === "bcc") bcc = splitEmails(val);
    else if (key === "subject") subject = val;
  }

  if (to.length === 0) {
    return { ok: false, reason: "mail_send directive missing `to:` recipients" };
  }
  if (!subject) {
    return { ok: false, reason: "mail_send directive missing `subject:`" };
  }
  if (!body) {
    return { ok: false, reason: "mail_send directive missing `body:`" };
  }
  return {
    ok: true,
    directive: {
      to,
      cc: cc.length ? cc : undefined,
      bcc: bcc.length ? bcc : undefined,
      subject,
      body,
    },
  };
}

// Bare local timestamp — LINE WORKS carries the zone in a separate field, so
// an embedded UTC offset would be silently misinterpreted. Seconds optional.
const CALENDAR_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

function parseCalendarCreate(
  inner: string,
): { ok: true; directive: CalendarCreateDirective } | { ok: false; reason: string } {
  // `description:` is the boundary — everything after it (to the end of the
  // directive) is the description, verbatim. Mirrors mail_send's `body:`.
  const descMarker = /(^|\n)\s*description\s*:/i.exec(inner);
  let headerPart: string;
  let description = "";
  if (descMarker) {
    headerPart = inner.slice(0, descMarker.index);
    description = inner
      .slice(descMarker.index + descMarker[0].length)
      .replace(/^\n/, "")
      .trim();
  } else {
    headerPart = inner;
  }

  let summary = "";
  let start = "";
  let end = "";
  let timeZone = "";
  let location = "";
  let attendees: string[] = [];
  for (const line of headerPart.split(/\r?\n/)) {
    const m = /^\s*(summary|start|end|timezone|location|attendees)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = (m[2] ?? "").trim();
    if (key === "summary") summary = val;
    else if (key === "start") start = val;
    else if (key === "end") end = val;
    else if (key === "timezone") timeZone = val;
    else if (key === "location") location = val;
    else if (key === "attendees") attendees = splitEmails(val);
  }

  if (!summary) return { ok: false, reason: "calendar_create directive missing `summary:`" };
  if (!start || !end) {
    return { ok: false, reason: "calendar_create directive missing `start:` or `end:`" };
  }
  if (!timeZone) {
    return {
      ok: false,
      reason: "calendar_create directive missing `timezone:` (IANA name, e.g. Asia/Taipei)",
    };
  }
  if (!CALENDAR_DT_RE.test(start) || !CALENDAR_DT_RE.test(end)) {
    return {
      ok: false,
      reason:
        "calendar_create start/end must be bare local `YYYY-MM-DDTHH:mm[:ss]` (no UTC offset)",
    };
  }
  const normalize = (dt: string) => (dt.length === 16 ? `${dt}:00` : dt);
  return {
    ok: true,
    directive: {
      summary,
      start: normalize(start),
      end: normalize(end),
      timeZone,
      location: location || undefined,
      attendeeEmails: attendees.length ? attendees : undefined,
      description: description || undefined,
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
