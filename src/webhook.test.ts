import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseInboundEvent, verifySignature } from "./webhook.js";

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

describe("verifySignature", () => {
  const secret = "bot-secret-xyz";
  const body = '{"type":"message","source":{"userId":"u-1"},"content":{"type":"text","text":"hi"}}';

  it("accepts a valid signature on a string body", () => {
    const sig = sign(body, secret);
    expect(
      verifySignature({ rawBody: body, signatureHeader: sig, botSecret: secret }),
    ).toBe(true);
  });

  it("accepts a valid signature on a Buffer body", () => {
    const buf = Buffer.from(body, "utf8");
    const sig = sign(body, secret);
    expect(
      verifySignature({ rawBody: buf, signatureHeader: sig, botSecret: secret }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = sign(body, secret);
    const tampered = body.replace("hi", "HI");
    expect(
      verifySignature({ rawBody: tampered, signatureHeader: sig, botSecret: secret }),
    ).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const sig = sign(body, "other-secret");
    expect(
      verifySignature({ rawBody: body, signatureHeader: sig, botSecret: secret }),
    ).toBe(false);
  });

  it("fails closed when the signature header is missing", () => {
    expect(
      verifySignature({ rawBody: body, signatureHeader: undefined, botSecret: secret }),
    ).toBe(false);
  });

  it("fails closed when the bot secret is empty", () => {
    expect(
      verifySignature({ rawBody: body, signatureHeader: "x", botSecret: "" }),
    ).toBe(false);
  });

  it("rejects a signature with wrong length (truncated)", () => {
    const sig = sign(body, secret).slice(0, 10);
    expect(
      verifySignature({ rawBody: body, signatureHeader: sig, botSecret: secret }),
    ).toBe(false);
  });
});

describe("parseInboundEvent", () => {
  it("parses a user text message", () => {
    const ev = parseInboundEvent({
      type: "message",
      source: { userId: "u-1", domainId: 42 },
      content: { type: "text", text: "hello" },
    });
    expect(ev?.kind).toBe("user-message");
    expect(ev?.source).toEqual({ type: "user", userId: "u-1", domainId: "42" });
    expect(ev?.content).toEqual({ type: "text", text: "hello" });
  });

  it("parses a channel text message", () => {
    const ev = parseInboundEvent({
      type: "message",
      source: { channelId: "c-1", userId: "u-2", domainId: "d-3" },
      content: { type: "text", text: "room" },
    });
    expect(ev?.kind).toBe("channel-message");
    expect(ev?.source).toEqual({
      type: "channel",
      channelId: "c-1",
      userId: "u-2",
      domainId: "d-3",
    });
  });

  it("parses sticker and location content", () => {
    const sticker = parseInboundEvent({
      type: "message",
      source: { userId: "u-1" },
      content: { type: "sticker", packageId: "p", stickerId: "s" },
    });
    expect(sticker?.content).toEqual({ type: "sticker", packageId: "p", stickerId: "s" });

    const loc = parseInboundEvent({
      type: "message",
      source: { userId: "u-1" },
      content: {
        type: "location",
        title: "Taipei",
        latitude: 25.04,
        longitude: 121.56,
      },
    });
    expect(loc?.content).toEqual({
      type: "location",
      title: "Taipei",
      latitude: 25.04,
      longitude: 121.56,
    });
  });

  it("maps join/leave and member events", () => {
    expect(
      parseInboundEvent({ type: "join", source: { channelId: "c-1" } })?.kind,
    ).toBe("bot-joined");
    expect(
      parseInboundEvent({ type: "leave", source: { channelId: "c-1" } })?.kind,
    ).toBe("bot-left");
    expect(
      parseInboundEvent({ type: "memberJoined", source: { channelId: "c-1" } })?.kind,
    ).toBe("member-joined");
    expect(
      parseInboundEvent({ type: "memberLeft", source: { channelId: "c-1" } })?.kind,
    ).toBe("member-left");
  });

  it("returns undefined for malformed events", () => {
    expect(parseInboundEvent(null)).toBeUndefined();
    expect(parseInboundEvent({})).toBeUndefined();
    expect(parseInboundEvent({ type: "message" })).toBeUndefined();
    expect(parseInboundEvent({ type: "message", source: {} })).toBeUndefined();
  });

  it("falls back to unknown kind for unrecognized event types", () => {
    const ev = parseInboundEvent({ type: "somethingNew", source: { userId: "u" } });
    expect(ev?.kind).toBe("unknown");
  });
});
