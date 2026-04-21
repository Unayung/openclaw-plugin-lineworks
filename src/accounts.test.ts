import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  hasLineWorksCredentials,
  listLineWorksAccountIds,
  resolveDefaultLineWorksAccountId,
  resolveLineWorksAccount,
} from "./accounts.js";

const base = {
  clientId: "cid",
  clientSecret: "csec",
  serviceAccount: "svc@e.com",
  privateKey: "PRIVATE",
  botId: "b1",
  botSecret: "bsec",
};

function cfg(lineworks: Record<string, unknown>) {
  return { channels: { lineworks } } as Parameters<typeof resolveLineWorksAccount>[0];
}

describe("resolveLineWorksAccount", () => {
  it("resolves the default (top-level) account", () => {
    const acc = resolveLineWorksAccount(cfg(base));
    expect(acc.accountId).toBe(DEFAULT_ACCOUNT_ID);
    expect(acc.clientId).toBe("cid");
    expect(acc.botId).toBe("b1");
    expect(acc.webhookPath).toBe("/lineworks/webhook");
    expect(acc.dmPolicy).toBe("pairing");
    expect(acc.groupPolicy).toBe("allowlist");
    expect(hasLineWorksCredentials(acc)).toBe(true);
  });

  it("resolves a named sub-account and inherits missing fields", () => {
    const acc = resolveLineWorksAccount(
      cfg({ ...base, accounts: { alt: { botId: "b2", botSecret: "bsec2" } } }),
      "alt",
    );
    expect(acc.accountId).toBe("alt");
    expect(acc.botId).toBe("b2");
    expect(acc.clientId).toBe("cid");
    expect(hasLineWorksCredentials(acc)).toBe(true);
  });

  it("reports missing credentials via hasLineWorksCredentials", () => {
    const acc = resolveLineWorksAccount(cfg({ clientId: "cid" }));
    expect(hasLineWorksCredentials(acc)).toBe(false);
  });
});

describe("listLineWorksAccountIds", () => {
  it("includes default + named accounts", () => {
    const ids = listLineWorksAccountIds(
      cfg({ ...base, accounts: { alpha: { botId: "a" }, beta: { botId: "b" } } }),
    );
    expect(ids).toContain(DEFAULT_ACCOUNT_ID);
    expect(ids).toContain("alpha");
    expect(ids).toContain("beta");
  });

  it("returns empty for missing channel config", () => {
    expect(listLineWorksAccountIds({ channels: {} } as Parameters<typeof listLineWorksAccountIds>[0])).toEqual([]);
  });
});

describe("resolveDefaultLineWorksAccountId", () => {
  it("returns the explicit default", () => {
    expect(
      resolveDefaultLineWorksAccountId(
        cfg({ ...base, defaultAccount: "alpha", accounts: { alpha: {} } }),
      ),
    ).toBe("alpha");
  });

  it("falls back to the first listed id", () => {
    expect(resolveDefaultLineWorksAccountId(cfg(base))).toBe(DEFAULT_ACCOUNT_ID);
  });
});
