import { describe, expect, it } from "vitest";
import { extractFlexDirectives } from "./flex-directive.js";

describe("extractFlexDirectives", () => {
  it("returns nothing for plain text", () => {
    const r = extractFlexDirectives("just a normal message");
    expect(r.messages).toHaveLength(0);
    expect(r.residualText).toBe("just a normal message");
    expect(r.parseErrors).toHaveLength(0);
  });

  it("extracts a single flex directive and strips it from text", () => {
    const r = extractFlexDirectives(
      'Here you go:\n[[flex: My card ||| {"type":"bubble","body":{"type":"box","layout":"vertical","contents":[]}}]]\nThanks.',
    );
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]!).toEqual({
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
    const r = extractFlexDirectives(
      '[[flex: A ||| {"type":"bubble"}]][[flex: B ||| {"type":"bubble"}]]',
    );
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0]!.altText).toBe("A");
    expect(r.messages[1]!.altText).toBe("B");
  });

  it("accepts a carousel contents shape", () => {
    const r = extractFlexDirectives(
      '[[flex: Catalog ||| {"type":"carousel","contents":[{"type":"bubble"},{"type":"bubble"}]}]]',
    );
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]!.contents.type).toBe("carousel");
  });

  it("reports parse errors for malformed JSON", () => {
    const r = extractFlexDirectives("[[flex: Bad ||| {not json}]]");
    expect(r.messages).toHaveLength(0);
    expect(r.parseErrors[0]!).toMatch(/JSON parse failed/);
    expect(r.residualText).toBe("");
  });

  it("reports missing separator", () => {
    const r = extractFlexDirectives('[[flex: {"type":"bubble"}]]');
    expect(r.messages).toHaveLength(0);
    expect(r.parseErrors[0]!).toMatch(/missing "\|\|\|"/);
  });

  it("truncates very long altText to 400 chars", () => {
    const alt = "x".repeat(800);
    const r = extractFlexDirectives(`[[flex: ${alt} ||| {"type":"bubble"}]]`);
    expect(r.messages[0]!.altText.length).toBe(400);
  });

  it("leaves square-bracket content that's not a flex directive alone", () => {
    const r = extractFlexDirectives("see [[this]] and [[flex-like-not-really]]");
    expect(r.messages).toHaveLength(0);
    expect(r.residualText).toBe("see [[this]] and [[flex-like-not-really]]");
  });
});
