import { describe, expect, it } from "vitest";
import { extractDirectives } from "./directives.js";

describe("extractDirectives — flex", () => {
  it("returns nothing for plain text", () => {
    const r = extractDirectives("just a normal message");
    expect(r.flex).toHaveLength(0);
    expect(r.locations).toHaveLength(0);
    expect(r.quickReply).toBeUndefined();
    expect(r.residualText).toBe("just a normal message");
    expect(r.parseErrors).toHaveLength(0);
  });

  it("extracts a single flex directive and strips it from text", () => {
    const r = extractDirectives(
      'Here you go:\n[[flex: My card ||| {"type":"bubble","body":{"type":"box","layout":"vertical","contents":[]}}]]\nThanks.',
    );
    expect(r.flex).toHaveLength(1);
    expect(r.flex[0]!).toEqual({
      type: "flex",
      altText: "My card",
      contents: {
        type: "bubble",
        body: { type: "box", layout: "vertical", contents: [] },
      },
    });
    expect(r.residualText).toBe("Here you go:\n\nThanks.");
    expect(r.parseErrors).toHaveLength(0);
  });

  it("extracts multiple flex directives", () => {
    const r = extractDirectives(
      '[[flex: A ||| {"type":"bubble"}]][[flex: B ||| {"type":"bubble"}]]',
    );
    expect(r.flex).toHaveLength(2);
    expect(r.flex[0]!.altText).toBe("A");
    expect(r.flex[1]!.altText).toBe("B");
  });

  it("accepts a carousel contents shape", () => {
    const r = extractDirectives(
      '[[flex: Catalog ||| {"type":"carousel","contents":[{"type":"bubble"},{"type":"bubble"}]}]]',
    );
    expect(r.flex).toHaveLength(1);
    expect(r.flex[0]!.contents.type).toBe("carousel");
  });

  it("reports flex JSON errors", () => {
    const r = extractDirectives("[[flex: Bad ||| {not json}]]");
    expect(r.flex).toHaveLength(0);
    expect(r.parseErrors[0]!).toMatch(/JSON parse failed/);
  });

  it("reports missing separator", () => {
    const r = extractDirectives('[[flex: {"type":"bubble"}]]');
    expect(r.flex).toHaveLength(0);
    expect(r.parseErrors[0]!).toMatch(/missing "\|\|\|"/);
  });

  it("truncates very long altText to 400 chars", () => {
    const alt = "x".repeat(800);
    const r = extractDirectives(`[[flex: ${alt} ||| {"type":"bubble"}]]`);
    expect(r.flex[0]!.altText.length).toBe(400);
  });

  it("leaves non-directive bracket content alone", () => {
    const r = extractDirectives("see [[this]] and [[flex-like-not-really]]");
    expect(r.flex).toHaveLength(0);
    expect(r.residualText).toBe("see [[this]] and [[flex-like-not-really]]");
  });
});

describe("extractDirectives — location", () => {
  it("parses a well-formed location", () => {
    const r = extractDirectives("[[location: Taipei 101 | No. 7, Section 5 | 25.0330 | 121.5654]]");
    expect(r.locations).toHaveLength(1);
    expect(r.locations[0]!).toEqual({
      type: "location",
      title: "Taipei 101",
      address: "No. 7, Section 5",
      latitude: 25.033,
      longitude: 121.5654,
    });
  });

  it("rejects non-numeric coordinates", () => {
    const r = extractDirectives("[[location: X | addr | not-a-lat | 10]]");
    expect(r.locations).toHaveLength(0);
    expect(r.parseErrors[0]!).toMatch(/non-numeric lat\/lng/);
  });

  it("rejects wrong field count", () => {
    const r = extractDirectives("[[location: only-one-field]]");
    expect(r.locations).toHaveLength(0);
    expect(r.parseErrors[0]!).toMatch(/expects/);
  });
});

describe("extractDirectives — quick_replies", () => {
  it("builds message-action items from plain labels", () => {
    const r = extractDirectives("pick: [[quick_replies: Yes, No, Maybe]]");
    expect(r.quickReply).toBeDefined();
    expect(r.quickReply!.items).toHaveLength(3);
    expect(r.quickReply!.items[0]!.action).toEqual({
      type: "message",
      label: "Yes",
      text: "Yes",
    });
  });

  it("builds uri-action for https targets", () => {
    const r = extractDirectives("[[quick_replies: Visit > https://openclaw.ai]]");
    expect(r.quickReply!.items[0]!.action).toEqual({
      type: "uri",
      label: "Visit",
      uri: "https://openclaw.ai",
    });
  });

  it("builds postback-action for data: prefix", () => {
    const r = extractDirectives("[[quick_replies: Accept > data:confirm=yes]]");
    expect(r.quickReply!.items[0]!.action).toEqual({
      type: "postback",
      label: "Accept",
      data: "confirm=yes",
      displayText: "Accept",
    });
  });

  it("rejects empty label list", () => {
    const r = extractDirectives("[[quick_replies: ]]");
    expect(r.quickReply).toBeUndefined();
    expect(r.parseErrors[0]!).toMatch(/no labels/);
  });

  it("rejects >13 items", () => {
    const labels = Array.from({ length: 14 }, (_, i) => `L${i}`).join(", ");
    const r = extractDirectives(`[[quick_replies: ${labels}]]`);
    expect(r.quickReply).toBeUndefined();
    expect(r.parseErrors[0]!).toMatch(/>13/);
  });

  it("takes only the first quick_replies directive", () => {
    const r = extractDirectives("[[quick_replies: A]][[quick_replies: B]]");
    expect(r.quickReply!.items[0]!.action.label).toBe("A");
  });
});

describe("extractDirectives — mail_send", () => {
  it("parses a well-formed mail_send block", () => {
    const r = extractDirectives(
      `here is a summary\n\n[[mail_send:\nto: alice@example.com, bob@example.com\ncc: carol@example.com\nsubject: Follow-up\nbody:\nHi Alice,\nHere is the summary.\n]]\nok`,
    );
    expect(r.mailSends).toHaveLength(1);
    expect(r.mailSends[0]!).toEqual({
      to: ["alice@example.com", "bob@example.com"],
      cc: ["carol@example.com"],
      bcc: undefined,
      subject: "Follow-up",
      body: "Hi Alice,\nHere is the summary.",
    });
    expect(r.residualText).toBe("here is a summary\n\nok");
    expect(r.parseErrors).toHaveLength(0);
  });

  it("rejects mail_send without to", () => {
    const r = extractDirectives(
      `[[mail_send:\nsubject: x\nbody:\ny\n]]`,
    );
    expect(r.mailSends).toHaveLength(0);
    expect(r.parseErrors[0]!).toMatch(/missing `to:`/);
  });

  it("rejects mail_send without subject", () => {
    const r = extractDirectives(
      `[[mail_send:\nto: a@b.com\nbody:\ny\n]]`,
    );
    expect(r.mailSends).toHaveLength(0);
    expect(r.parseErrors[0]!).toMatch(/missing `subject:`/);
  });

  it("rejects mail_send without body", () => {
    const r = extractDirectives(
      `[[mail_send:\nto: a@b.com\nsubject: x\n]]`,
    );
    expect(r.mailSends).toHaveLength(0);
    expect(r.parseErrors[0]!).toMatch(/missing `body:`/);
  });

  it("preserves multi-line body verbatim", () => {
    const r = extractDirectives(
      `[[mail_send:\nto: a@b.com\nsubject: x\nbody:\nline one\n\nline three after blank\n]]`,
    );
    expect(r.mailSends[0]!.body).toBe("line one\n\nline three after blank");
  });
});

describe("extractDirectives — calendar_create", () => {
  it("parses a well-formed calendar_create block", () => {
    const r = extractDirectives(
      `booked!\n\n[[calendar_create:\nsummary: Quarterly sync\nstart: 2026-07-15T14:00\nend: 2026-07-15T15:00:00\ntimezone: Asia/Taipei\nlocation: Room A\nattendees: a@b.com, c@d.com\ndescription:\nAgenda line one.\nLine two.\n]]`,
    );
    expect(r.calendarCreates).toHaveLength(1);
    expect(r.calendarCreates[0]!).toEqual({
      summary: "Quarterly sync",
      start: "2026-07-15T14:00:00",
      end: "2026-07-15T15:00:00",
      timeZone: "Asia/Taipei",
      location: "Room A",
      attendeeEmails: ["a@b.com", "c@d.com"],
      description: "Agenda line one.\nLine two.",
    });
    expect(r.residualText).toBe("booked!");
    expect(r.parseErrors).toHaveLength(0);
  });

  it("rejects calendar_create without timezone", () => {
    const r = extractDirectives(
      `[[calendar_create:\nsummary: x\nstart: 2026-07-15T14:00:00\nend: 2026-07-15T15:00:00\n]]`,
    );
    expect(r.calendarCreates).toHaveLength(0);
    expect(r.parseErrors[0]!).toMatch(/missing `timezone:`/);
  });

  it("rejects start/end with a UTC offset", () => {
    const r = extractDirectives(
      `[[calendar_create:\nsummary: x\nstart: 2026-07-15T14:00:00+09:00\nend: 2026-07-15T15:00:00\ntimezone: Asia/Tokyo\n]]`,
    );
    expect(r.calendarCreates).toHaveLength(0);
    expect(r.parseErrors[0]!).toMatch(/bare local/);
  });
});

describe("extractDirectives — combined", () => {
  it("handles flex + location + quick_replies together", () => {
    const r = extractDirectives(
      'Here:\n[[flex: F ||| {"type":"bubble"}]]\n[[location: P | A | 1 | 2]]\n[[quick_replies: Yes, No]]\nbye',
    );
    expect(r.flex).toHaveLength(1);
    expect(r.locations).toHaveLength(1);
    expect(r.quickReply!.items).toHaveLength(2);
    expect(r.residualText).toBe("Here:\n\nbye");
  });
});
