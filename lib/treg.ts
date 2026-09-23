/**
 * Treg API gateway — lets Engram-only clients discover and call external APIs
 * through Treg's catalog without needing a separate Treg MCP connector.
 *
 * Config via env:
 *   TREG_TOKEN        — API token (required to enable Treg tools)
 *   TREG_BASE_URL     — API base URL (default: https://treg.to)
 *   TREG_ORG_ID       — Org ID or team slug for balance endpoint (e.g. "12345" or "harold-builds")
 *   TREG_MAX_USD_PER_CALL — Maximum cost per tool_call (default: 0.01)
 *
 * When TREG_TOKEN is unset, Treg tools are hidden from the MCP surface entirely.
 */

/** Treg API base URL. */
export const TREG_BASE_URL = process.env.TREG_BASE_URL?.replace(/\/$/, "") || "https://treg.to";

/** Treg API token — NOT exposed to MCP responses, only used server-side. */
const TREG_TOKEN = process.env.TREG_TOKEN ?? "";

/** Treg org ID or team slug — optional; per-org tokens bake this in, but required for balance if not. */
const TREG_ORG_ID = process.env.TREG_ORG_ID ?? "";

/** Maximum USD per call — calls above this fail with a clear error. */
export const TREG_MAX_USD_PER_CALL = (() => {
  const v = process.env.TREG_MAX_USD_PER_CALL;
  if (!v) return 0.01;
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : 0.01;
})();

/** True when Treg tools should be exposed. */
export function tregEnabled(): boolean {
  return TREG_TOKEN !== "";
}

/** Get the token for internal use only — never expose this to MCP responses. */
export function getTregToken(): string {
  return TREG_TOKEN;
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

/** Org info returned by GET /orgs. */
interface TregOrg {
  id: number;
  slug?: string;
  name?: string;
}

/** In-process cache for resolved org ID (slug → numeric). */
let resolvedOrgIdCache: { slug: string; numericId: number } | null = null;

/**
 * Resolve TREG_ORG_ID to a numeric ID.
 * - If already numeric, returns it as-is.
 * - If a slug, fetches GET /orgs and finds the matching org by slug (or name as fallback).
 * - Caches the result in-process for the server lifetime.
 */
export async function resolveOrgId(): Promise<number> {
  if (!TREG_ORG_ID) {
    throw new Error(
      "Treg balance requires TREG_ORG_ID to be set. " +
        "Per-org API tokens bake the org in, but TREG_ORG_ID is still needed for this endpoint.",
    );
  }

  if (isNumericOrgId(TREG_ORG_ID)) {
    return parseInt(TREG_ORG_ID, 10);
  }

  if (resolvedOrgIdCache && resolvedOrgIdCache.slug === TREG_ORG_ID) {
    return resolvedOrgIdCache.numericId;
  }

  const orgs = await fetchOrgs();
  const slug = TREG_ORG_ID.toLowerCase();
  const match = orgs.find(
    (o) => o.slug?.toLowerCase() === slug || o.name?.toLowerCase() === slug,
  );

  if (!match) {
    throw new Error(
      `Treg org slug "${TREG_ORG_ID}" not found. Available orgs: ${orgs.map((o) => o.slug || o.name || o.id).join(", ")}`,
    );
  }

  resolvedOrgIdCache = { slug: TREG_ORG_ID, numericId: match.id };
  return match.id;
}

/** Fetch the list of orgs accessible to the current token. */
async function fetchOrgs(): Promise<TregOrg[]> {
  if (!tregEnabled()) {
    throw new Error("Treg is not configured — set TREG_TOKEN to enable.");
  }

  const url = `${TREG_BASE_URL}/orgs`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Treg-Token": TREG_TOKEN,
  };

  if (TREG_ORG_ID && !isNumericOrgId(TREG_ORG_ID)) {
    headers["X-Treg-Org"] = TREG_ORG_ID;
  }

  const res = await fetch(url, { method: "GET", headers });

  if (!res.ok) {
    let msg = `Treg API error: ${res.status} ${res.statusText}`;
    try {
      const err = (await res.json()) as TregError;
      if (err.error) msg = `Treg API: ${stringifyErrorField(err.error)}`;
      else if (err.detail) msg = `Treg API: ${stringifyErrorField(err.detail)}`;
    } catch {
      // ignore parse errors
    }
    throw new Error(msg);
  }

  return res.json() as Promise<TregOrg[]>;
}

/** Clear the org ID cache (for testing). */
export function clearOrgIdCache(): void {
  resolvedOrgIdCache = null;
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
  cost_micro?: number;
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
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
  query?: Record<string, string | number | undefined>;
}

async function tregFetch<T>(endpoint: string, options: TregFetchOptions = {}): Promise<T> {
  if (!tregEnabled()) {
    throw new Error("Treg is not configured — set TREG_TOKEN to enable.");
  }

  const { method = "GET", body, query } = options;

  let url = `${TREG_BASE_URL}${endpoint}`;
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
      "X-Treg-Token": TREG_TOKEN,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    let msg = `Treg API error: ${res.status} ${res.statusText}`;
    try {
      const err = (await res.json()) as TregError;
      if (err.error) msg = `Treg API: ${stringifyErrorField(err.error)}`;
      else if (err.detail) msg = `Treg API: ${stringifyErrorField(err.detail)}`;
    } catch {
      // ignore parse errors
    }
    throw new Error(msg);
  }

  return res.json() as Promise<T>;
}

/**
 * Search the Treg catalog for endpoints matching a task description.
 * Safe for read-scope tokens — no cost, no side effects.
 */
export async function catalogSearch(query: string, limit?: number): Promise<TregCatalogSearchResult> {
  return tregFetch<TregCatalogSearchResult>("/catalog/search", {
    query: { q: query, limit: limit ?? 10 },
  });
}

/**
 * Get full details for a specific endpoint (parameters, exact price).
 * Safe for read-scope tokens — no cost, no side effects.
 */
export async function catalogGet(endpointId: string): Promise<TregCatalogGetResult> {
  return tregFetch<TregCatalogGetResult>(`/catalog/endpoints/${encodeURIComponent(endpointId)}`);
}

/**
 * Call an endpoint through Treg. COSTS MONEY — write-scope only.
 * Refuses if the endpoint's cost exceeds TREG_MAX_USD_PER_CALL.
 */
export async function call(
  endpointId: string,
  params: Record<string, unknown>,
  estimatedUsd?: number,
): Promise<TregCallResult> {
  if (estimatedUsd !== undefined && estimatedUsd > TREG_MAX_USD_PER_CALL) {
    throw new Error(
      `Refusing tool_call: estimated cost $${estimatedUsd.toFixed(4)} exceeds the cap of $${TREG_MAX_USD_PER_CALL.toFixed(4)}. ` +
        `Ask the operator to raise TREG_MAX_USD_PER_CALL or get human approval for expensive calls.`,
    );
  }

  const hasBody = Object.keys(params).length > 0;
  const res = await tregFetch<unknown>(`/call/${encodeURIComponent(endpointId)}`, {
    method: hasBody ? "POST" : "GET",
    body: hasBody ? params : undefined,
  });

  return { data: res };
}

/**
 * Get the current Treg balance. WRITE-SCOPE — reveals spending info.
 * Requires TREG_ORG_ID to be set if using an identity token (per-org tokens bake this in).
 * TREG_ORG_ID can be either a numeric org ID or a team slug (e.g. "harold-builds").
 */
export async function balance(): Promise<TregBalanceResult> {
  const numericOrgId = await resolveOrgId();
  return tregFetch<TregBalanceResult>(`/orgs/${numericOrgId}/balance`);
}

// ── Logging for ops ────────────────────────────────────────────────────────────

export function logTregCall(
  action: "search" | "get" | "call" | "balance",
  details: { endpointId?: string; usdEstimate?: number; success: boolean; error?: string },
): void {
  const parts = [`[treg] ${action}`];
  if (details.endpointId) parts.push(`endpoint=${details.endpointId}`);
  if (details.usdEstimate !== undefined) parts.push(`usd=${details.usdEstimate.toFixed(4)}`);
  parts.push(details.success ? "ok" : `fail: ${details.error ?? "unknown"}`);
  console.info(parts.join(" "));
}
