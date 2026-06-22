import { describe, expect, it } from "vitest";
import { parseStickerAck } from "./inbound-turn.js";

describe("parseStickerAck", () => {
  it("parses a well-formed sticker ack", () => {
    expect(parseStickerAck("sticker:7482:13835641")).toEqual({
      packageId: "7482",
      stickerId: "13835641",
    });
  });

  it("returns null for plain text acks", () => {
    expect(parseStickerAck("⋯")).toBeNull();
    expect(parseStickerAck("thinking…")).toBeNull();
  });

  it("returns null when packageId or stickerId is missing", () => {
    expect(parseStickerAck("sticker:")).toBeNull();
    expect(parseStickerAck("sticker:7482")).toBeNull();
    expect(parseStickerAck("sticker:7482:")).toBeNull();
    expect(parseStickerAck("sticker::13835641")).toBeNull();
  });
});
