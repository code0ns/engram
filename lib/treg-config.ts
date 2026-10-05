import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "@/lib/config";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

/**
 * Per-workspace Treg credential + spend limits, and the daily spend ledger.
 *
 * A workspace may carry its own Treg token / org / caps (clean billing per client). Anything it
 * does not set falls back to the env values (TREG_TOKEN, TREG_ORG_ID, TREG_BASE_URL,
 * TREG_MAX_USD_PER_CALL, TREG_MAX_USD_PER_DAY), so a single-user install keeps working with no
 * dashboard setup.
 *
 * Kept in its own files (not repos.json): lib/repos.ts's strip() only removes `tokenEnc` by name,
 * so a second secret on a repo record could leak through GET /api/repos. Nothing here is ever
 * returned to a client except via publicTregConfig(), which carries `hasToken`, never the token.
 */

const STATE_DIR = process.env.ENGRAM_STATE_DIR || DATA_ROOT;
const CONFIG_FILE = path.join(STATE_DIR, "treg.json");
const LEDGER_FILE = path.join(STATE_DIR, "treg-ledger.json");

/** Ledger key for calls that resolve to no workspace (stdio / legacy sample vault). */
export const GLOBAL_LEDGER_KEY = "_global";

/** Env defaults — also exported for tool descriptions and tests. */
export const TREG_BASE_URL = process.env.TREG_BASE_URL?.replace(/\/$/, "") || "https://treg.to";

export const TREG_MAX_USD_PER_CALL = positive(process.env.TREG_MAX_USD_PER_CALL, 0.01);
export const TREG_MAX_USD_PER_DAY = positive(process.env.TREG_MAX_USD_PER_DAY, 1);

function positive(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Everything lib/treg.ts needs to talk to Treg on behalf of one workspace. */
export interface TregConfig {
  token: string;
  baseUrl: string;
  orgId: string;
  perCallCapUsd: number;
  dailyCapUsd: number;
  /** Where spend is recorded: the workspace id, or GLOBAL_LEDGER_KEY. */
  ledgerKey: string;
  /** Whose token this is: the workspace's own, or the shared env one. */
  source: "workspace" | "global";
}

interface StoredTreg {
  tokenEnc?: string;
  orgId?: string;
  perCallCapUsd?: number;
  dailyCapUsd?: number;
}

type Store = Record<string, StoredTreg>;
/** ledgerKey -> UTC day (YYYY-MM-DD) -> USD spent. */
type Ledger = Record<string, Record<string, number>>;

/** Days of ledger history kept — enough to show a trend, small enough to never grow unbounded. */
const LEDGER_KEEP_DAYS = 35;

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Write via a temp file + rename so a crash mid-write can't leave a half-written secrets file. */
function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function safeDecrypt(stored: string | undefined): string {
  if (!stored) return "";
  try {
    return decryptSecret(stored);
  } catch {
    return "";
  }
}

const today = () => new Date().toISOString().slice(0, 10);

function envToken(): string {
  return process.env.TREG_TOKEN ?? "";
}

/**
 * The effective Treg config for a workspace: its own values over the env defaults.
 * `workspaceId` null = no workspace (stdio, legacy vault) -> env values only.
 */
export function resolveTregConfig(workspaceId: string | null | undefined): TregConfig {
  const own = workspaceId ? readJson<Store>(CONFIG_FILE, {})[workspaceId] : undefined;
  const ownToken = safeDecrypt(own?.tokenEnc);
  return {
    token: ownToken || envToken(),
    baseUrl: TREG_BASE_URL,
    orgId: own?.orgId ?? process.env.TREG_ORG_ID ?? "",
    perCallCapUsd: own?.perCallCapUsd ?? positive(process.env.TREG_MAX_USD_PER_CALL, 0.01),
    dailyCapUsd: own?.dailyCapUsd ?? positive(process.env.TREG_MAX_USD_PER_DAY, 1),
    ledgerKey: workspaceId || GLOBAL_LEDGER_KEY,
    source: ownToken ? "workspace" : "global",
  };
}

export function spentToday(ledgerKey: string): number {
  return readJson<Ledger>(LEDGER_FILE, {})[ledgerKey]?.[today()] ?? 0;
}

/** Add (or, with a negative amount, give back) spend for today. Prunes old days. */
export function recordSpend(ledgerKey: string, usd: number): void {
  if (!Number.isFinite(usd) || usd === 0) return;
  const ledger = readJson<Ledger>(LEDGER_FILE, {});
  const days = (ledger[ledgerKey] ??= {});
  const d = today();
  days[d] = Math.max(0, (days[d] ?? 0) + usd);
  const cutoff = new Date(Date.now() - LEDGER_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  for (const day of Object.keys(days)) if (day < cutoff) delete days[day];
  writeJson(LEDGER_FILE, ledger);
}

/** What the dashboard may see. Never contains the token. */
export interface PublicTregConfig {
  /** This workspace has its own token set. */
  hasToken: boolean;
  /** The shared env token exists, so an unset workspace token still works. */
  globalAvailable: boolean;
  /** Tools are usable for this workspace (own token or global fallback). */
  enabled: boolean;
  orgId: string;
  perCallCapUsd: number;
  dailyCapUsd: number;
  spentTodayUsd: number;
  /** Which of the two caps are explicit overrides vs inherited defaults. */
  overrides: { orgId: boolean; perCallCapUsd: boolean; dailyCapUsd: boolean };
}

export function publicTregConfig(workspaceId: string): PublicTregConfig {
  const own = readJson<Store>(CONFIG_FILE, {})[workspaceId];
  const cfg = resolveTregConfig(workspaceId);
  return {
    hasToken: Boolean(safeDecrypt(own?.tokenEnc)),
    globalAvailable: envToken() !== "",
    enabled: cfg.token !== "",
    orgId: cfg.orgId,
    perCallCapUsd: cfg.perCallCapUsd,
    dailyCapUsd: cfg.dailyCapUsd,
    spentTodayUsd: spentToday(cfg.ledgerKey),
    overrides: {
      orgId: own?.orgId !== undefined,
      perCallCapUsd: own?.perCallCapUsd !== undefined,
      dailyCapUsd: own?.dailyCapUsd !== undefined,
    },
  };
}

export interface TregConfigPatch {
  /** Write-only. A non-empty string replaces the stored token. */
  token?: string;
  clearToken?: boolean;
  /** "" or null clears the override (back to the env default). */
  orgId?: string | null;
  perCallCapUsd?: number | null;
  dailyCapUsd?: number | null;
}

function checkCap(name: string, v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new Error(`${name} must be a positive number of US dollars`);
  }
  return v;
}

/** Apply a settings patch for one workspace. Throws on invalid values (callers map to 400). */
export function setTregConfig(workspaceId: string, patch: TregConfigPatch): void {
  // Validate everything before writing anything.
  const perCall = "perCallCapUsd" in patch ? checkCap("perCallCapUsd", patch.perCallCapUsd) : undefined;
  const daily = "dailyCapUsd" in patch ? checkCap("dailyCapUsd", patch.dailyCapUsd) : undefined;

  const store = readJson<Store>(CONFIG_FILE, {});
  const next: StoredTreg = { ...store[workspaceId] };

  if (patch.clearToken) delete next.tokenEnc;
  if (typeof patch.token === "string" && patch.token.trim()) next.tokenEnc = encryptSecret(patch.token.trim());
  if ("orgId" in patch) {
    const o = typeof patch.orgId === "string" ? patch.orgId.trim() : "";
    if (o) next.orgId = o;
    else delete next.orgId;
  }
  if ("perCallCapUsd" in patch) {
    if (perCall === undefined) delete next.perCallCapUsd;
    else next.perCallCapUsd = perCall;
  }
  if ("dailyCapUsd" in patch) {
    if (daily === undefined) delete next.dailyCapUsd;
    else next.dailyCapUsd = daily;
  }

  if (Object.keys(next).length === 0) delete store[workspaceId];
  else store[workspaceId] = next;
  writeJson(CONFIG_FILE, store);
}

/** Forget a deleted workspace's token, caps and spend history. */
export function pruneTreg(workspaceId: string): void {
  const store = readJson<Store>(CONFIG_FILE, {});
  if (workspaceId in store) {
    delete store[workspaceId];
    writeJson(CONFIG_FILE, store);
  }
  const ledger = readJson<Ledger>(LEDGER_FILE, {});
  if (workspaceId in ledger) {
    delete ledger[workspaceId];
    writeJson(LEDGER_FILE, ledger);
  }
}
