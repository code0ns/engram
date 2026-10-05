/**
 * Treg API gateway — lets Engram-only clients discover and call external APIs
 * through Treg's catalog without needing a separate Treg MCP connector.
 *
 * Every function takes an explicit TregConfig (lib/treg-config.ts): the workspace's own token,
 * org and spend limits, falling back to the env values:
 *   TREG_TOKEN            — API token (Treg tools are hidden for a workspace with no token at all)
 *   TREG_BASE_URL         — API base URL (default: https://treg.to)
 *   TREG_ORG_ID           — Org ID or team slug for the balance endpoint (e.g. "12345" or "harold-builds")
 *   TREG_MAX_USD_PER_CALL — Maximum cost per tool_call (default: 0.01)
 *   TREG_MAX_USD_PER_DAY  — Maximum spend per workspace per UTC day (default: 1.00)
 *
 * HTTP method selection:
 *   Treg endpoints can be GET or POST (or other methods). The catalog's top-level `method` field
 *   wins, then the `call_template` (`--method GET`), then POST:
 *   - GET/DELETE endpoints: params go in the query string
 *   - POST/PUT/PATCH endpoints: params go in the request body as JSON
 */

import {
  GLOBAL_LEDGER_KEY,
  TREG_BASE_URL,
  TREG_MAX_USD_PER_CALL,
  TREG_MAX_USD_PER_DAY,
  recordSpend,
  resolveTregConfig,
  spentToday,
  type TregConfig,
} from "./treg-config";

export { GLOBAL_LEDGER_KEY, TREG_BASE_URL, TREG_MAX_USD_PER_CALL, TREG_MAX_USD_PER_DAY, resolveTregConfig, spentToday };
export type { TregConfig };

/** True when Treg tools should be exposed for this config (a token exists, own or inherited). */
export function tregEnabled(cfg: TregConfig): boolean {
  return cfg.token !== "";
}

// ── HTTP Method Handling ───────────────────────────────────────────────────────

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const BODY_METHODS: HttpMethod[] = ["POST", "PUT", "PATCH"];

const VALID_HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/**
 * Normalize an HTTP method string to a valid HttpMethod type.
 * Returns undefined if the input is not a recognized HTTP method.
 */
export function normalizeHttpMethod(method: string | undefined | null): HttpMethod | undefined {
  if (!method) return undefined;
  const upper = method.toUpperCase();
  if (VALID_HTTP_METHODS.includes(upper as HttpMethod)) {
    return upper as HttpMethod;
  }
  return undefined;
}

/**
 * Extract the HTTP method from a Treg catalog `call_template` string.
 * Templates look like: `treg call endpoint-id --method GET --url "..." ...`
 * Returns undefined if no method is specified (defaults to POST for body, GET otherwise).
 */
export function extractMethodFromTemplate(callTemplate: string | undefined): HttpMethod | undefined {
  if (!callTemplate) return undefined;
  const match = callTemplate.match(/--method\s+(\w+)/i);
  if (!match) return undefined;
  return normalizeHttpMethod(match[1]);
}

interface EndpointInfo {
  method: HttpMethod;
  /** Catalog price in USD, when the catalog states one. */
  priceUsd?: number;
  at: number;
}

/** Prices change; a method never does. Re-read the catalog at most this often per endpoint. */
const ENDPOINT_INFO_TTL_MS = 10 * 60_000;

/** In-process cache keyed by base URL + endpoint id. Avoids a catalog round trip per call. */
const endpointInfoCache = new Map<string, EndpointInfo>();

/** The price a catalog entry states, in USD, or undefined when it states none. */
export function catalogPriceUsd(info: Pick<TregCatalogGetResult, "cost" | "usd_per_call">): number | undefined {
  const p = info.cost?.usd ?? info.usd_per_call;
  return typeof p === "number" && Number.isFinite(p) && p >= 0 ? p : undefined;
}

/**
 * Method + catalog price for an endpoint (cached). Method resolution order:
 * 1. Catalog's top-level `method` field (e.g., `method: "GET"`)
 * 2. Parsed from `call_template` (e.g., `--method GET`)
 * 3. Default to "POST"
 *
 * Throws when the catalog can't be reached, so a caller that needs the price (call()) can
 * refuse rather than spend blind.
 */
async function getEndpointInfo(cfg: TregConfig, endpointId: string): Promise<EndpointInfo> {
  const key = `${cfg.baseUrl}|${endpointId}`;
  const cached = endpointInfoCache.get(key);
  if (cached && Date.now() - cached.at < ENDPOINT_INFO_TTL_MS) return cached;

  const info = await catalogGet(cfg, endpointId);
  const entry: EndpointInfo = {
    method: normalizeHttpMethod(info.method) ?? extractMethodFromTemplate(info.call_template) ?? "POST",
    priceUsd: catalogPriceUsd(info),
    at: Date.now(),
  };
  endpointInfoCache.set(key, entry);
  return entry;
}

/** Get the HTTP method for an endpoint (cached); POST if the catalog can't be read. */
export async function getEndpointMethod(cfg: TregConfig, endpointId: string): Promise<HttpMethod> {
  try {
    return (await getEndpointInfo(cfg, endpointId)).method;
  } catch {
    return "POST";
  }
}

/** Clear the endpoint cache (useful for testing). */
export function clearEndpointMethodCache(): void {
  endpointInfoCache.clear();
}

// ── HTTP Client ────────────────────────────────────────────────────────────────

export interface TregError {
  error?: string | object;
  detail?: string | object | unknown[];
  code?: string;
  details?: unknown;
}

/** Stringify an error field, handling objects that would print as [object Object]. */
export function stringifyErrorField(field: unknown): string {
  if (field === null || field === undefined) return "";
  if (typeof field === "string") return field;
  return JSON.stringify(field);
}

// ── Org ID Resolution ──────────────────────────────────────────────────────────

/** Check if a string is a numeric org ID (all digits). */
export function isNumericOrgId(value: string): boolean {
  return /^\d+$/.test(value);
}

/** Org info returned by GET /orgs — Treg may use `org_id` or `id` for the numeric identifier. */
interface TregOrgRaw {
  id?: number;
  org_id?: number;
  slug?: string;
  name?: string;
}

/**
 * Extract the numeric org ID from a raw Treg org object.
 * Treg's API may use `org_id` or `id` as the field name.
 */
export function extractOrgId(org: TregOrgRaw): number | undefined {
  const id = org.org_id ?? org.id;
  return typeof id === "number" ? id : undefined;
}

/** In-process cache for resolved org IDs (slug -> numeric), keyed per credential. */
const resolvedOrgIdCache = new Map<string, number>();

/**
 * Resolve the config's org to a numeric ID.
 * - If already numeric, returns it as-is.
 * - If a slug, fetches GET /orgs and finds the matching org by slug (or name as fallback).
 * - Caches the result in-process, per credential (two workspaces can use the same slug on
 *   different tokens).
 */
export async function resolveOrgId(cfg: TregConfig): Promise<number> {
  if (!cfg.orgId) {
    throw new Error(
      "Treg balance requires an org to be set for this workspace (Access > Workspaces > Settings, or TREG_ORG_ID). " +
        "Per-org API tokens bake the org in, but the org is still needed for this endpoint.",
    );
  }

  if (isNumericOrgId(cfg.orgId)) {
    return parseInt(cfg.orgId, 10);
  }

  const cacheKey = `${cfg.baseUrl}\n${cfg.token}\n${cfg.orgId}`;
  const cached = resolvedOrgIdCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const orgs = await fetchOrgs(cfg);
  const slug = cfg.orgId.toLowerCase();
  const match = orgs.find(
    (o) => o.slug?.toLowerCase() === slug || o.name?.toLowerCase() === slug,
  );

  if (!match) {
    const available = orgs.map((o) => o.slug || o.name || extractOrgId(o) || "(unknown)").join(", ");
    throw new Error(
      `Treg org slug "${cfg.orgId}" not found. Available orgs: ${available || "(none)"}`,
    );
  }

  const numericId = extractOrgId(match);
  if (numericId === undefined) {
    throw new Error(
      `Treg org "${cfg.orgId}" matched but has no numeric ID. ` +
        `Org data: ${JSON.stringify(match)}. ` +
        `Expected field "org_id" or "id" with an integer value.`,
    );
  }

  resolvedOrgIdCache.set(cacheKey, numericId);
  return numericId;
}

/** Fetch the list of orgs accessible to the config's token. */
async function fetchOrgs(cfg: TregConfig): Promise<TregOrgRaw[]> {
  if (!tregEnabled(cfg)) {
    throw new Error("Treg is not configured for this workspace — set a Treg token (Access > Workspaces > Settings) or TREG_TOKEN.");
  }

  const url = `${cfg.baseUrl}/orgs`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Treg-Token": cfg.token,
  };

  if (cfg.orgId && !isNumericOrgId(cfg.orgId)) {
    headers["X-Treg-Org"] = cfg.orgId;
  }

  const res = await fetch(url, { method: "GET", headers });

  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }

  return res.json() as Promise<TregOrgRaw[]>;
}

/** Clear the org ID cache (for testing). */
export function clearOrgIdCache(): void {
  resolvedOrgIdCache.clear();
}

async function errorMessage(res: Response): Promise<string> {
  let msg = `Treg API error: ${res.status} ${res.statusText}`;
  try {
    const err = (await res.json()) as TregError;
    if (err.error) msg = `Treg API: ${stringifyErrorField(err.error)}`;
    else if (err.detail) msg = `Treg API: ${stringifyErrorField(err.detail)}`;
  } catch {
    // ignore parse errors
  }
  return msg;
}

export interface TregCatalogEndpointCost {
  usd?: number;
  type?: string;
  value?: number;
  currency?: string;
}

export interface TregCatalogEndpoint {
  id: string;
  provider: string;
  name: string;
  summary?: string;
  cost?: TregCatalogEndpointCost;
  /** Alternative price field sometimes returned by Treg. */
  usd_per_call?: number;
  platform_eligible?: boolean;
  observed?: {
    ok_rate?: number;
    samples?: number;
  };
}

export interface TregCatalogSearchResult {
  query: string;
  count: number;
  total: number;
  results: TregCatalogEndpoint[];
  hints?: string[];
}

export interface TregCatalogGetResult {
  id: string;
  provider: string;
  name: string;
  summary?: string;
  cost?: TregCatalogEndpointCost;
  /** Top-level HTTP method from catalog (e.g., "GET", "POST"). Preferred over call_template parsing. */
  method?: string;
  /** Alternative price field sometimes returned by Treg. */
  usd_per_call?: number;
  platform_eligible?: boolean;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  call_template?: string;
  siblings?: Array<{
    id: string;
    provider: string;
    cost?: TregCatalogEndpointCost;
  }>;
  observed?: {
    ok_rate?: number;
    samples?: number;
    p50_ms?: number;
  };
}

export interface TregCallResult {
  data?: unknown;
  call_id?: string;
  /** What this call cost: the amount Treg reported, else the catalog price we reserved. */
  cost_usd?: number;
  error?: string;
}

export interface TregBalanceResult {
  balance_micro: number;
  balance_usd: number;
  in_flight_micro?: number;
  currency?: string;
}

interface TregFetchOptions {
  method?: HttpMethod;
  body?: Record<string, unknown>;
  query?: Record<string, string | number | boolean | undefined>;
}

async function tregFetch<T>(cfg: TregConfig, endpoint: string, options: TregFetchOptions = {}): Promise<T> {
  if (!tregEnabled(cfg)) {
    throw new Error("Treg is not configured for this workspace — set a Treg token (Access > Workspaces > Settings) or TREG_TOKEN.");
  }

  const { method = "GET", body, query } = options;

  let url = `${cfg.baseUrl}${endpoint}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Treg-Token": cfg.token,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }

  return res.json() as Promise<T>;
}

/**
 * Search the Treg catalog for endpoints matching a task description.
 * Safe for read-scope tokens — no cost, no side effects.
 */
export async function catalogSearch(cfg: TregConfig, query: string, limit?: number): Promise<TregCatalogSearchResult> {
  return tregFetch<TregCatalogSearchResult>(cfg, "/catalog/search", {
    query: { q: query, limit: limit ?? 10 },
  });
}

/**
 * Get full details for a specific endpoint (parameters, exact price).
 * Safe for read-scope tokens — no cost, no side effects.
 */
export async function catalogGet(cfg: TregConfig, endpointId: string): Promise<TregCatalogGetResult> {
  return tregFetch<TregCatalogGetResult>(cfg, `/catalog/endpoints/${encodeURIComponent(endpointId)}`);
}

/**
 * Options for calling a Treg endpoint.
 */
export interface TregCallOptions {
  /** Explicit HTTP method override. If not provided, looks up from catalog. */
  method?: HttpMethod;
  /** Expected cost from tool_get. Advisory only: the catalog price is authoritative. */
  estimatedUsd?: number;
}

/** Pull the charged amount / call id out of whatever shape Treg answered with. */
function readCharge(res: unknown): { chargedUsd?: number; callId?: string } {
  if (typeof res !== "object" || res === null) return {};
  const r = res as Record<string, unknown>;
  const cost = r.cost as { usd?: unknown } | undefined;
  const candidates = [r.cost_usd, r.usd_charged, cost?.usd];
  const chargedUsd = candidates.find((c): c is number => typeof c === "number" && Number.isFinite(c) && c >= 0);
  return { chargedUsd, callId: typeof r.call_id === "string" ? r.call_id : undefined };
}

/**
 * Call an endpoint through Treg. COSTS MONEY — write-scope only.
 *
 * Spend is enforced here, not trusted from the caller. The price used is the larger of the
 * agent-supplied `estimatedUsd` and the catalog's own price (an agent can omit or understate the
 * estimate; it cannot change the catalog). The call is refused when that price exceeds the
 * per-call cap, or when today's spend plus this call would exceed the daily cap. The price is
 * reserved against the daily ledger before the request and settled to the real charge after.
 *
 * HTTP method selection:
 * - If `options.method` is provided, uses that
 * - Otherwise, looks up the method from the catalog (cached per endpoint)
 * - GET/DELETE: params are passed as query string
 * - POST/PUT/PATCH: params are passed as JSON body
 */
export async function call(
  cfg: TregConfig,
  endpointId: string,
  params: Record<string, unknown>,
  estimatedUsdOrOptions?: number | TregCallOptions,
): Promise<TregCallResult> {
  const options: TregCallOptions =
    typeof estimatedUsdOrOptions === "number"
      ? { estimatedUsd: estimatedUsdOrOptions }
      : estimatedUsdOrOptions ?? {};

  const { estimatedUsd } = options;

  // An estimate above the cap is refused before any network round trip.
  if (estimatedUsd !== undefined && estimatedUsd > cfg.perCallCapUsd) {
    throw perCallCapError(estimatedUsd, cfg.perCallCapUsd);
  }

  let info: EndpointInfo | undefined;
  try {
    info = await getEndpointInfo(cfg, endpointId);
  } catch (e) {
    // Without the catalog we know the method only if the caller gave it, and never the price.
    if (!tregEnabled(cfg)) throw e;
    if (estimatedUsd === undefined || !options.method) {
      throw new Error(
        `Refusing tool_call: could not read the catalog price for "${endpointId}" (${(e as Error).message}). ` +
          `Retry, or pass both estimated_usd and method.`,
      );
    }
  }

  const price = Math.max(estimatedUsd ?? 0, info?.priceUsd ?? 0);
  if (price > cfg.perCallCapUsd) throw perCallCapError(price, cfg.perCallCapUsd);

  const spent = spentToday(cfg.ledgerKey);
  if (spent + price > cfg.dailyCapUsd) {
    throw new Error(
      `Refusing tool_call: today's spend $${spent.toFixed(4)} plus this call $${price.toFixed(4)} would exceed ` +
        `the daily cap of $${cfg.dailyCapUsd.toFixed(4)} for this workspace. ` +
        `Ask a workspace admin to raise the daily cap (Access > Workspaces > Settings), or try again tomorrow (UTC).`,
    );
  }

  const method = options.method ?? info?.method ?? "POST";
  const hasParams = Object.keys(params).length > 0;
  const useBody = BODY_METHODS.includes(method);

  recordSpend(cfg.ledgerKey, price); // reserve
  let res: unknown;
  try {
    res = await tregFetch<unknown>(cfg, `/call/${encodeURIComponent(endpointId)}`, {
      method,
      body: useBody && hasParams ? params : undefined,
      query: !useBody && hasParams ? (params as Record<string, string | number | boolean | undefined>) : undefined,
    });
  } catch (e) {
    recordSpend(cfg.ledgerKey, -price); // a failed call isn't charged
    throw e;
  }

  const { chargedUsd, callId } = readCharge(res);
  const charged = chargedUsd ?? price;
  recordSpend(cfg.ledgerKey, charged - price); // settle to the real charge

  return { data: res, call_id: callId, cost_usd: charged };
}

function perCallCapError(usd: number, cap: number): Error {
  return new Error(
    `Refusing tool_call: estimated cost $${usd.toFixed(4)} exceeds the cap of $${cap.toFixed(4)} per call. ` +
      `Ask a workspace admin to raise the per-call cap (Access > Workspaces > Settings, or TREG_MAX_USD_PER_CALL) ` +
      `or get human approval for expensive calls.`,
  );
}

/**
 * Get the current Treg balance. WRITE-SCOPE — reveals spending info.
 * Needs an org on the config when using an identity token (per-org tokens bake it in).
 * The org can be a numeric org ID or a team slug (e.g. "harold-builds").
 */
export async function balance(cfg: TregConfig): Promise<TregBalanceResult> {
  const numericOrgId = await resolveOrgId(cfg);
  return tregFetch<TregBalanceResult>(cfg, `/orgs/${numericOrgId}/balance`);
}

// ── Logging for ops ────────────────────────────────────────────────────────────

export function logTregCall(
  action: "search" | "get" | "call" | "balance",
  details: { endpointId?: string; usdEstimate?: number; success: boolean; error?: string; workspace?: string },
): void {
  const parts = [`[treg] ${action}`];
  if (details.workspace) parts.push(`ws=${details.workspace}`);
  if (details.endpointId) parts.push(`endpoint=${details.endpointId}`);
  if (details.usdEstimate !== undefined) parts.push(`usd=${details.usdEstimate.toFixed(4)}`);
  parts.push(details.success ? "ok" : `fail: ${details.error ?? "unknown"}`);
  console.info(parts.join(" "));
}
