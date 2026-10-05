import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  pruneTreg,
  publicTregConfig,
  recordSpend,
  resolveTregConfig,
  setTregConfig,
  spentToday,
} from "./treg-config";

const DATA = process.env.ENGRAM_DATA_DIR!;
const CONFIG_FILE = path.join(DATA, "treg.json");

let n = 0;
/** A fresh workspace id per test — the config and ledger are files shared by the whole run. */
const ws = () => `cfg-ws-${++n}-${crypto.randomUUID().slice(0, 8)}`;

const ENV_KEYS = ["TREG_TOKEN", "TREG_ORG_ID", "TREG_MAX_USD_PER_CALL", "TREG_MAX_USD_PER_DAY"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  delete process.env.TREG_TOKEN;
  delete process.env.TREG_ORG_ID;
  delete process.env.TREG_MAX_USD_PER_CALL;
  delete process.env.TREG_MAX_USD_PER_DAY;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("resolveTregConfig", () => {
  test("a workspace with nothing set uses the env values and the default caps", () => {
    process.env.TREG_TOKEN = "env-token";
    process.env.TREG_ORG_ID = "acme";
    const c = resolveTregConfig(ws());
    expect(c.token).toBe("env-token");
    expect(c.source).toBe("global");
    expect(c.orgId).toBe("acme");
    expect(c.perCallCapUsd).toBe(0.01);
    expect(c.dailyCapUsd).toBe(1);
  });

  test("env caps change the defaults", () => {
    process.env.TREG_MAX_USD_PER_CALL = "0.05";
    process.env.TREG_MAX_USD_PER_DAY = "2.5";
    const c = resolveTregConfig(ws());
    expect(c.perCallCapUsd).toBe(0.05);
    expect(c.dailyCapUsd).toBe(2.5);
  });

  test("garbage env caps fall back to the defaults", () => {
    process.env.TREG_MAX_USD_PER_CALL = "-3";
    process.env.TREG_MAX_USD_PER_DAY = "lots";
    const c = resolveTregConfig(ws());
    expect(c.perCallCapUsd).toBe(0.01);
    expect(c.dailyCapUsd).toBe(1);
  });

  test("no workspace and no env token means no token (tools hidden)", () => {
    expect(resolveTregConfig(null).token).toBe("");
  });

  test("no workspace uses the global ledger key", () => {
    expect(resolveTregConfig(null).ledgerKey).toBe("_global");
  });

  test("a workspace's own token beats the env token", () => {
    process.env.TREG_TOKEN = "env-token";
    const id = ws();
    setTregConfig(id, { token: "ws-token" });
    const c = resolveTregConfig(id);
    expect(c.token).toBe("ws-token");
    expect(c.source).toBe("workspace");
    expect(c.ledgerKey).toBe(id);
  });

  test("tokens are isolated between workspaces", () => {
    const a = ws();
    const b = ws();
    setTregConfig(a, { token: "token-a" });
    expect(resolveTregConfig(a).token).toBe("token-a");
    expect(resolveTregConfig(b).token).toBe("");
  });

  test("clearing the workspace token falls back to the env token", () => {
    process.env.TREG_TOKEN = "env-token";
    const id = ws();
    setTregConfig(id, { token: "ws-token" });
    setTregConfig(id, { clearToken: true });
    const c = resolveTregConfig(id);
    expect(c.token).toBe("env-token");
    expect(c.source).toBe("global");
  });
});

describe("setTregConfig", () => {
  test("caps and org are overrides; null resets each to the default", () => {
    const id = ws();
    setTregConfig(id, { perCallCapUsd: 0.05, dailyCapUsd: 3, orgId: "client-org" });
    let c = resolveTregConfig(id);
    expect([c.perCallCapUsd, c.dailyCapUsd, c.orgId]).toEqual([0.05, 3, "client-org"]);

    setTregConfig(id, { perCallCapUsd: null, dailyCapUsd: null, orgId: null });
    c = resolveTregConfig(id);
    expect([c.perCallCapUsd, c.dailyCapUsd, c.orgId]).toEqual([0.01, 1, ""]);
  });

  test("a blank token does not wipe the stored one", () => {
    const id = ws();
    setTregConfig(id, { token: "ws-token" });
    setTregConfig(id, { token: "   ", dailyCapUsd: 2 });
    expect(resolveTregConfig(id).token).toBe("ws-token");
  });

  test("rejects non-positive, non-finite and non-numeric caps without changing anything", () => {
    const id = ws();
    setTregConfig(id, { dailyCapUsd: 2 });
    for (const bad of [0, -1, Number.NaN, Infinity, "5" as unknown as number]) {
      expect(() => setTregConfig(id, { dailyCapUsd: bad, token: "should-not-land" })).toThrow(/positive number/);
    }
    const c = resolveTregConfig(id);
    expect(c.dailyCapUsd).toBe(2);
    expect(c.token).toBe("");
  });

  test("the token is not stored in plaintext on disk", () => {
    const id = ws();
    setTregConfig(id, { token: "plainly-visible-secret" });
    expect(fs.readFileSync(CONFIG_FILE, "utf8")).not.toContain("plainly-visible-secret");
  });
});

describe("publicTregConfig", () => {
  test("never contains the token, only whether one is set", () => {
    const id = ws();
    setTregConfig(id, { token: "super-secret-token", dailyCapUsd: 2 });
    const pub = publicTregConfig(id);
    expect(pub.hasToken).toBe(true);
    expect(pub.enabled).toBe(true);
    expect(JSON.stringify(pub)).not.toContain("super-secret-token");
    expect(pub.overrides.dailyCapUsd).toBe(true);
    expect(pub.overrides.perCallCapUsd).toBe(false);
  });

  test("a workspace relying on the shared token reports that", () => {
    process.env.TREG_TOKEN = "env-token";
    const pub = publicTregConfig(ws());
    expect(pub.hasToken).toBe(false);
    expect(pub.globalAvailable).toBe(true);
    expect(pub.enabled).toBe(true);
  });

  test("with no token anywhere it is disabled", () => {
    const pub = publicTregConfig(ws());
    expect(pub.enabled).toBe(false);
    expect(pub.globalAvailable).toBe(false);
  });

  test("reports today's spend", () => {
    const id = ws();
    recordSpend(id, 0.25);
    expect(publicTregConfig(id).spentTodayUsd).toBeCloseTo(0.25, 6);
  });
});

describe("spend ledger", () => {
  test("accumulates, can be given back, and never goes below zero", () => {
    const id = ws();
    expect(spentToday(id)).toBe(0);
    recordSpend(id, 0.1);
    recordSpend(id, 0.2);
    expect(spentToday(id)).toBeCloseTo(0.3, 6);
    recordSpend(id, -0.1);
    expect(spentToday(id)).toBeCloseTo(0.2, 6);
    recordSpend(id, -5);
    expect(spentToday(id)).toBe(0);
  });

  test("ignores zero and non-finite amounts", () => {
    const id = ws();
    recordSpend(id, 0);
    recordSpend(id, Number.NaN);
    expect(spentToday(id)).toBe(0);
  });

  test("workspaces keep separate books", () => {
    const a = ws();
    const b = ws();
    recordSpend(a, 1);
    expect(spentToday(b)).toBe(0);
  });
});

describe("pruneTreg", () => {
  test("forgets a deleted workspace's token, caps and spend", () => {
    const id = ws();
    setTregConfig(id, { token: "ws-token", dailyCapUsd: 5 });
    recordSpend(id, 0.5);
    pruneTreg(id);
    expect(resolveTregConfig(id).token).toBe("");
    expect(resolveTregConfig(id).dailyCapUsd).toBe(1);
    expect(spentToday(id)).toBe(0);
  });
});
