import { describe, expect, it } from "vitest";
import { formatMailSummaries, looksLikeMailCheckRequest } from "./mail.js";

describe("looksLikeMailCheckRequest", () => {
  it("matches common Chinese phrasings", () => {
    expect(looksLikeMailCheckRequest("可以查看我的信箱嗎")).toBe(true);
    expect(looksLikeMailCheckRequest("看一下信箱")).toBe(true);
    expect(looksLikeMailCheckRequest("我的信箱最近有什麼")).toBe(true);
    expect(looksLikeMailCheckRequest("檢查郵件")).toBe(true);
    expect(looksLikeMailCheckRequest("讀一下電郵")).toBe(true);
  });

  it("matches common English phrasings", () => {
    expect(looksLikeMailCheckRequest("check my mail please")).toBe(true);
    expect(looksLikeMailCheckRequest("read my inbox")).toBe(true);
    expect(looksLikeMailCheckRequest("show me my email")).toBe(true);
    expect(looksLikeMailCheckRequest("inbox summary?")).toBe(true);
  });

  it("ignores unrelated messages", () => {
    expect(looksLikeMailCheckRequest("what time is it")).toBe(false);
    expect(looksLikeMailCheckRequest("你好 Racco")).toBe(false);
    expect(looksLikeMailCheckRequest("")).toBe(false);
  });
});

describe("formatMailSummaries", () => {
  it("returns empty marker for empty input", () => {
    expect(formatMailSummaries([])).toMatch(/empty|no matching/i);
  });

  it("renders a compact list with unread markers", () => {
    const out = formatMailSummaries([
      {
        id: "1",
        subject: "PO confirmation",
        from: "alice@vendor.com",
        snippet: "Your order has been received.",
        receivedAt: "2026-04-21T10:00:00+08:00",
        isUnread: true,
      },
      {
        id: "2",
        subject: "Weekly digest",
        from: "noreply@service.com",
        snippet: "This week's top items…",
        isUnread: false,
      },
    ]);
    expect(out).toMatch(/2 recent mail/);
    expect(out).toMatch(/PO confirmation.*🔵.*from alice@vendor\.com/s);
    expect(out).toMatch(/Weekly digest.*from noreply@service\.com/s);
    expect(out).toMatch(/Your order has been received/);
  });

  it("truncates long snippets", () => {
    const long = "x".repeat(300);
    const out = formatMailSummaries([{ id: "1", subject: "s", snippet: long }], {
      maxSnippetChars: 50,
    });
    expect(out).toMatch(/x{50}…/);
    expect(out).not.toMatch(/x{60}/);
  });
});
