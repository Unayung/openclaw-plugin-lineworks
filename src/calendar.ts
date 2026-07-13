import { getUserAccessToken } from "./oauth.js";
import type { ResolvedLineWorksAccount } from "./types.js";

const LINEWORKS_API_BASE = "https://www.worksapis.com/v1.0";

/**
 * LINE WORKS calendar date/time. Verified against
 * developers.worksmobile.com/en/docs/calendar-default-event-user-create:
 * `dateTime` is a bare local timestamp (`YYYY-MM-DDTHH:mm:ss`, no offset) —
 * the timezone is carried separately in `timeZone` (IANA name, e.g.
 * "Asia/Taipei").
 */
export interface LineWorksCalendarDateTime {
  dateTime: string;
  timeZone: string;
}

/**
 * Minimal event input. Deliberately narrower than what the API allows:
 * `end` is required here (the API technically allows omitting it), and
 * recurrence is not exposed at all (out of scope for this module).
 */
export interface LineWorksCalendarEventInput {
  summary: string;
  start: LineWorksCalendarDateTime;
  end: LineWorksCalendarDateTime;
  description?: string;
  location?: string;
  attendeeEmails?: string[];
}

export type LineWorksCreateEventResult =
  | { ok: true; eventId?: string }
  | { ok: false; reason: string };

/**
 * Create an event in a user's default LINE WORKS calendar.
 *
 * Endpoint: POST /v1.0/users/{userId}/calendar/events
 * Scope:    `calendar`
 *
 * Requires a per-user OAuth token (via `getUserAccessToken`) — see
 * specs/calendar.md for why: the docs say service-account tokens are also
 * accepted, but this module always writes as the target user for identity
 * correctness. Never throws; API/auth failures come back as
 * `{ok:false, reason}`.
 */
export async function createCalendarEvent(args: {
  account: ResolvedLineWorksAccount;
  userId: string;
  event: LineWorksCalendarEventInput;
  log?: { warn?: (msg: string) => void };
}): Promise<LineWorksCreateEventResult> {
  const { account, userId, event } = args;
  const warn = (reason: string) =>
    args.log?.warn?.(`LINE WORKS createCalendarEvent(${userId}) failed: ${reason}`);

  try {
    const access = await getUserAccessToken({ account, userId, log: args.log });
    if (!access) {
      warn("no OAuth token for user (not authorized)");
      return { ok: false, reason: "not_authorized" };
    }

    const url = `${LINEWORKS_API_BASE}/users/${encodeURIComponent(userId)}/calendar/events`;
    const payload: Record<string, unknown> = {
      eventComponents: [
        {
          summary: event.summary,
          description: event.description,
          location: event.location,
          start: { dateTime: event.start.dateTime, timeZone: event.start.timeZone },
          end: { dateTime: event.end.dateTime, timeZone: event.end.timeZone },
          attendees: event.attendeeEmails?.map((email) => ({ email })),
        },
      ],
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${access.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      warn(`${res.status} ${text.slice(0, 200)}`);
      return { ok: false, reason: `${res.status} ${text.slice(0, 200)}` };
    }

    const json = (await res.json().catch(() => ({}))) as {
      eventComponents?: Array<{ eventId?: string }>;
    };
    const eventId = json.eventComponents?.[0]?.eventId;
    return eventId ? { ok: true, eventId } : { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warn(reason);
    return { ok: false, reason };
  }
}

export interface LineWorksCalendarEventSummary {
  eventId: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: LineWorksCalendarDateTime;
  end?: LineWorksCalendarDateTime;
}

/** Default lookahead window when `untilDateTime` isn't given: 7 days. */
const DEFAULT_LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_COUNT = 20;

/**
 * List upcoming events from a user's default LINE WORKS calendar.
 *
 * Endpoint: GET /v1.0/users/{userId}/calendar/events?fromDateTime=...&untilDateTime=...
 * Scope:    `calendar` or `calendar.read`
 *
 * `fromDateTime`/`untilDateTime` are required by the API; when omitted here
 * they default to "now" and "now + 7 days". LINE WORKS does not offer a
 * server-side result cap — `count` (default 20) truncates the response
 * client-side.
 *
 * Fails CLOSED: any HTTP error (e.g. 403 for a missing/insufficient token),
 * unexpected response shape, or thrown error returns `null` — never an empty
 * array a caller could mistake for "no events".
 */
export async function listUpcomingEvents(args: {
  account: ResolvedLineWorksAccount;
  userId: string;
  fromDateTime?: string;
  untilDateTime?: string;
  count?: number;
  log?: { warn?: (msg: string) => void };
}): Promise<LineWorksCalendarEventSummary[] | null> {
  const { account, userId } = args;
  const warn = (reason: string) =>
    args.log?.warn?.(`LINE WORKS listUpcomingEvents(${userId}) failed: ${reason}`);

  try {
    const access = await getUserAccessToken({ account, userId, log: args.log });
    if (!access) {
      warn("no OAuth token for user (not authorized)");
      return null;
    }

    const now = Date.now();
    const fromDateTime = args.fromDateTime ?? new Date(now).toISOString();
    const untilDateTime =
      args.untilDateTime ?? new Date(now + DEFAULT_LOOKAHEAD_MS).toISOString();
    const count = Math.max(1, args.count ?? DEFAULT_COUNT);

    const qs = new URLSearchParams();
    qs.set("fromDateTime", fromDateTime);
    qs.set("untilDateTime", untilDateTime);
    const url = `${LINEWORKS_API_BASE}/users/${encodeURIComponent(
      userId,
    )}/calendar/events?${qs.toString()}`;

    const res = await fetch(url, {
      headers: { authorization: `Bearer ${access.token}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      warn(`${res.status} ${text.slice(0, 200)}`);
      return null;
    }

    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const events = json["events"];
    if (!Array.isArray(events)) {
      warn("unexpected response shape (events is not an array)");
      return null;
    }

    const summaries: LineWorksCalendarEventSummary[] = [];
    for (const entry of events) {
      const components = (entry as Record<string, unknown> | null)?.["eventComponents"];
      const first = Array.isArray(components)
        ? (components[0] as Record<string, unknown> | undefined)
        : undefined;
      if (!first || typeof first["eventId"] !== "string") continue;
      summaries.push({
        eventId: first["eventId"] as string,
        summary: typeof first["summary"] === "string" ? (first["summary"] as string) : undefined,
        description:
          typeof first["description"] === "string"
            ? (first["description"] as string)
            : undefined,
        location:
          typeof first["location"] === "string" ? (first["location"] as string) : undefined,
        start: first["start"] as LineWorksCalendarDateTime | undefined,
        end: first["end"] as LineWorksCalendarDateTime | undefined,
      });
    }

    return summaries.slice(0, count);
  } catch (err) {
    warn(err instanceof Error ? err.message : String(err));
    return null;
  }
}
