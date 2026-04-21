import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  listLineWorksAccountIds,
  resolveDefaultLineWorksAccountId,
  resolveLineWorksAccount,
} from "./accounts.js";

const baseAccount = {
  clientId: "cid",
  clientSecret: "csec",
  serviceAccount: "svc@e.com",
  privateKey: "PRIVATE",
  botId: "b1",
  botSecret: "bsec",
};

describe("resolveLineWorksAccount", () => {
  it("resolves the default (top-level) account", () => {
    const acc = resolveLineWorksAccount({ config: { ...baseAccount } });
    expect(acc).toBeDefined();
    expect(acc!.accountId).toBe(DEFAULT_ACCOUNT_ID);
    expect(acc!.clientId).toBe("cid");
    expect(acc!.botId).toBe("b1");
  });

  it("resolves a named sub-account and inherits missing fields", () => {
    const acc = resolveLineWorksAccount({
      config: {
        ...baseAccount,
        accounts: { alt: { botId: "b2", botSecret: "bsec2" } },
      },
      accountId: "alt",
    });
    expect(acc).toBeDefined();
    expect(acc!.accountId).toBe("alt");
    expect(acc!.botId).toBe("b2");
    expect(acc!.clientId).toBe("cid");
  });

  it("returns undefined when required fields are missing", () => {
    const acc = resolveLineWorksAccount({ config: { clientId: "cid" } });
    expect(acc).toBeUndefined();
  });
});

describe("listLineWorksAccountIds", () => {
  it("includes default + named accounts", () => {
    const ids = listLineWorksAccountIds({
      ...baseAccount,
      accounts: { alpha: { botId: "a" }, beta: { botId: "b" } },
    });
    expect(ids.sort()).toEqual([DEFAULT_ACCOUNT_ID, "alpha", "beta"].sort());
  });
});

describe("resolveDefaultLineWorksAccountId", () => {
  it("returns the explicit default", () => {
    expect(
      resolveDefaultLineWorksAccountId({
        ...baseAccount,
        defaultAccount: "alpha",
        accounts: { alpha: {} },
      }),
    ).toBe("alpha");
  });

  it("falls back to the first listed id", () => {
    expect(resolveDefaultLineWorksAccountId({ ...baseAccount })).toBe(DEFAULT_ACCOUNT_ID);
  });
});
