import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCalendarEvent, listUpcomingEvents } from "./calendar.js";
import { saveOAuthToken } from "./oauth-store.js";
import type { ResolvedLineWorksAccount } from "./types.js";

function makeAccount(): ResolvedLineWorksAccount {
  return {
    accountId: "default",
    enabled: true,
    clientId: "cid",
    clientSecret: "csec",
    serviceAccount: "svc@e.com",
    privateKey: "",
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
    oauthScopes: "calendar,calendar.read",
    config: {},
  };
}

async function seedUserToken(accountId: string, userId: string): Promise<void> {
  await saveOAuthToken(accountId, {
    userId,
    accessToken: "user-tkn",
    refreshToken: "refresh-tkn",
    tokenType: "Bearer",
    expiresAt: Date.now() + 10 * 60 * 1000,
    scope: "calendar,calendar.read",
    grantedAt: new Date().toISOString(),
  });
}

type CapturedCall = {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: string;
};

function mockFetchOnce(response: Response): { calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const mock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    calls.push({ url: url.toString(), method: init?.method, headers, body: init?.body as string | undefined });
    return response;
  }) as unknown as typeof fetch;
  globalThis.fetch = mock;
  return { calls };
}

describe("calendar", () => {
  const originalFetch = globalThis.fetch;
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lineworks-oauth-test-"));
    process.env.OPENCLAW_HOME = tmpHome;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    delete process.env.OPENCLAW_HOME;
    await fs.promises.rm(tmpHome, { recursive: true, force: true });
  });

  describe("createCalendarEvent", () => {
    it("POSTs the event with the bearer token and returns the created eventId", async () => {
      const account = makeAccount();
      await seedUserToken(account.accountId, "user-1");
      const { calls } = mockFetchOnce(
        new Response(
          JSON.stringify({
            eventComponents: [{ eventId: "evt-123", summary: "Sync" }],
            organizerCalendarId: "calendar-abc",
          }),
          { status: 201 },
        ),
      );

      const result = await createCalendarEvent({
        account,
        userId: "user-1",
        event: {
          summary: "Sync",
          start: { dateTime: "2026-08-01T10:00:00", timeZone: "Asia/Taipei" },
          end: { dateTime: "2026-08-01T11:00:00", timeZone: "Asia/Taipei" },
          description: "Weekly sync",
          location: "Room 2",
          attendeeEmails: ["a@example.com", "b@example.com"],
        },
      });

      expect(result).toEqual({ ok: true, eventId: "evt-123" });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("https://www.worksapis.com/v1.0/users/user-1/calendar/events");
      expect(calls[0]!.method).toBe("POST");
      expect(calls[0]!.headers.authorization).toBe("Bearer user-tkn");
      expect(JSON.parse(calls[0]!.body!)).toEqual({
        eventComponents: [
          {
            summary: "Sync",
            description: "Weekly sync",
            location: "Room 2",
            start: { dateTime: "2026-08-01T10:00:00", timeZone: "Asia/Taipei" },
            end: { dateTime: "2026-08-01T11:00:00", timeZone: "Asia/Taipei" },
            attendees: [{ email: "a@example.com" }, { email: "b@example.com" }],
          },
        ],
      });
    });

    it("returns ok:false with a reason on API error (never throws)", async () => {
      const account = makeAccount();
      await seedUserToken(account.accountId, "user-1");
      mockFetchOnce(new Response("bad request", { status: 400 }));
      const warnings: string[] = [];

      const result = await createCalendarEvent({
        account,
        userId: "user-1",
        event: {
          summary: "Sync",
          start: { dateTime: "2026-08-01T10:00:00", timeZone: "Asia/Taipei" },
          end: { dateTime: "2026-08-01T11:00:00", timeZone: "Asia/Taipei" },
        },
        log: { warn: (m) => warnings.push(m) },
      });

      expect(result.ok).toBe(false);
      expect((result as { ok: false; reason: string }).reason).toContain("400");
      expect(warnings.join("\n")).toContain("400");
    });
  });

  describe("listUpcomingEvents", () => {
    it("GETs the events endpoint and returns summaries", async () => {
      const account = makeAccount();
      await seedUserToken(account.accountId, "user-1");
      const { calls } = mockFetchOnce(
        new Response(
          JSON.stringify({
            events: [
              {
                eventComponents: [
                  {
                    eventId: "evt-1",
                    summary: "Standup",
                    start: { dateTime: "2026-08-01T09:00:00", timeZone: "Asia/Taipei" },
                    end: { dateTime: "2026-08-01T09:15:00", timeZone: "Asia/Taipei" },
                  },
                ],
                organizerCalendarId: "calendar-abc",
              },
            ],
          }),
          { status: 200 },
        ),
      );

      const events = await listUpcomingEvents({
        account,
        userId: "user-1",
        fromDateTime: "2026-08-01T00:00:00Z",
        untilDateTime: "2026-08-02T00:00:00Z",
      });

      expect(events).toEqual([
        {
          eventId: "evt-1",
          summary: "Standup",
          start: { dateTime: "2026-08-01T09:00:00", timeZone: "Asia/Taipei" },
          end: { dateTime: "2026-08-01T09:15:00", timeZone: "Asia/Taipei" },
        },
      ]);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBeUndefined(); // default GET
      expect(calls[0]!.url).toBe(
        "https://www.worksapis.com/v1.0/users/user-1/calendar/events?fromDateTime=2026-08-01T00%3A00%3A00Z&untilDateTime=2026-08-02T00%3A00%3A00Z",
      );
      expect(calls[0]!.headers.authorization).toBe("Bearer user-tkn");
    });

    it("returns null (not an empty list) on 403", async () => {
      const account = makeAccount();
      await seedUserToken(account.accountId, "user-1");
      mockFetchOnce(new Response("forbidden", { status: 403 }));
      const warnings: string[] = [];

      const events = await listUpcomingEvents({
        account,
        userId: "user-1",
        log: { warn: (m) => warnings.push(m) },
      });

      expect(events).toBeNull();
      expect(events).not.toEqual([]);
      expect(warnings.join("\n")).toContain("403");
    });
  });
});
