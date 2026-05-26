import { describe, expect, it } from "vitest";
import {
  isSenderAllowedByUsers,
  resolveLineWorksChannelConfig,
} from "./channel-config.js";
import type { ResolvedLineWorksChannelEntry } from "./types.js";

function entry(
  partial: Partial<ResolvedLineWorksChannelEntry> = {},
): ResolvedLineWorksChannelEntry {
  return { enabled: true, requireMention: undefined, users: [], ...partial };
}

describe("resolveLineWorksChannelConfig", () => {
  it("groupPolicy=disabled always blocks", () => {
    const r = resolveLineWorksChannelConfig({
      channelId: "C1",
      channels: { C1: entry() },
      groupPolicy: "disabled",
      defaultRequireMention: false,
    });
    expect(r.allowed).toBe(false);
  });

  it("groupPolicy=open allows anywhere even with empty map", () => {
    const r = resolveLineWorksChannelConfig({
      channelId: "C1",
      channels: {},
      groupPolicy: "open",
      defaultRequireMention: true,
    });
    expect(r).toEqual({ allowed: true, requireMention: true, users: [], matchKey: undefined });
  });

  it("groupPolicy=allowlist with empty channels is open by default", () => {
    const r = resolveLineWorksChannelConfig({
      channelId: "C1",
      channels: {},
      groupPolicy: "allowlist",
      defaultRequireMention: false,
    });
    expect(r.allowed).toBe(true);
    expect(r.users).toEqual([]);
  });

  it("groupPolicy=allowlist + non-empty map + no match + no wildcard = blocked", () => {
    const r = resolveLineWorksChannelConfig({
      channelId: "C2",
      channels: { C1: entry({ users: ["U1"] }) },
      groupPolicy: "allowlist",
      defaultRequireMention: false,
    });
    expect(r.allowed).toBe(false);
  });

  it("matches direct channelId entry", () => {
    const r = resolveLineWorksChannelConfig({
      channelId: "C1",
      channels: { C1: entry({ users: ["U1", "U2"], requireMention: true }) },
      groupPolicy: "allowlist",
      defaultRequireMention: false,
    });
    expect(r.allowed).toBe(true);
    expect(r.requireMention).toBe(true);
    expect(r.users).toEqual(["U1", "U2"]);
    expect(r.matchKey).toBe("C1");
  });

  it("falls back to '*' wildcard when channelId not listed", () => {
    const r = resolveLineWorksChannelConfig({
      channelId: "C99",
      channels: { C1: entry(), "*": entry({ users: ["U-anyone"], requireMention: false }) },
      groupPolicy: "allowlist",
      defaultRequireMention: true,
    });
    expect(r.allowed).toBe(true);
    expect(r.requireMention).toBe(false);
    expect(r.users).toEqual(["U-anyone"]);
    expect(r.matchKey).toBe("*");
  });

  it("entry-level enabled=false blocks even when listed", () => {
    const r = resolveLineWorksChannelConfig({
      channelId: "C1",
      channels: { C1: entry({ enabled: false }) },
      groupPolicy: "allowlist",
      defaultRequireMention: false,
    });
    expect(r.allowed).toBe(false);
  });

  it("falls back to defaultRequireMention when entry has none", () => {
    const r = resolveLineWorksChannelConfig({
      channelId: "C1",
      channels: { C1: entry() },
      groupPolicy: "allowlist",
      defaultRequireMention: true,
    });
    expect(r.requireMention).toBe(true);
  });
});

describe("isSenderAllowedByUsers", () => {
  it("empty list means no restriction", () => {
    expect(isSenderAllowedByUsers([], "U1")).toBe(true);
    expect(isSenderAllowedByUsers([], undefined)).toBe(true);
  });

  it("'*' acts as anyone-allowed", () => {
    expect(isSenderAllowedByUsers(["*"], "anyone")).toBe(true);
    expect(isSenderAllowedByUsers(["*"], undefined)).toBe(true);
  });

  it("only listed userIds allowed when sender provided", () => {
    expect(isSenderAllowedByUsers(["U1", "U2"], "U1")).toBe(true);
    expect(isSenderAllowedByUsers(["U1", "U2"], "U3")).toBe(false);
  });

  it("missing sender id is blocked when list non-empty", () => {
    expect(isSenderAllowedByUsers(["U1"], undefined)).toBe(false);
  });
});
