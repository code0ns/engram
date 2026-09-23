/**
 * Treg API gateway — lets Engram-only clients discover and call external APIs
 * through Treg's catalog without needing a separate Treg MCP connector.
 *
 * Config via env:
 *   TREG_TOKEN        — API token (required to enable Treg tools)
 *   TREG_BASE_URL     — API base URL (default: https://api.treg.ai)
 *   TREG_MAX_USD_PER_CALL — Maximum cost per tool_call (default: 0.01)
 *
 * When TREG_TOKEN is unset, Treg tools are hidden from the MCP surface entirely.
 */

/** Treg API base URL. */
export const TREG_BASE_URL = process.env.TREG_BASE_URL?.replace(/\/$/, "") || "https://api.treg.ai";

/** Treg API token — NOT exposed to MCP responses, only used server-side. */
const TREG_TOKEN = process.env.TREG_TOKEN ?? "";

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
  error: string;
  code?: string;
  details?: unknown;
}

export interface TregCatalogEndpoint {
  endpoint_id: string;
  provider: string;
  name: string;
  description?: string;
  usd_per_call?: number;
  no_key_needed?: boolean;
  reliability?: number;
  tags?: string[];
}

export interface TregCatalogSearchResult {
  endpoints: TregCatalogEndpoint[];
  total?: number;
}

export interface TregCatalogGetResult {
  endpoint_id: string;
  provider: string;
  name: string;
  description?: string;
  usd_per_call: number;
  no_key_needed?: boolean;
  reliability?: number;
  parameters?: Record<string, unknown>;
  response_schema?: Record<string, unknown>;
  tags?: string[];
}

export interface TregCallResult {
  data?: unknown;
  call_id?: string;
  usd_charged?: number;
  error?: string;
}

export interface TregBalanceResult {
  balance_usd: number;
  currency?: string;
}

async function tregFetch<T>(endpoint: string, body?: Record<string, unknown>): Promise<T> {
  if (!tregEnabled()) {
    throw new Error("Treg is not configured — set TREG_TOKEN to enable.");
  }

  const url = `${TREG_BASE_URL}${endpoint}`;
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TREG_TOKEN}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    let msg = `Treg API error: ${res.status} ${res.statusText}`;
    try {
      const err = (await res.json()) as TregError;
      if (err.error) msg = `Treg API: ${err.error}`;
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
  return tregFetch<TregCatalogSearchResult>("/v1/catalog/search", {
    query,
    limit: limit ?? 10,
  });
}

/**
 * Get full details for a specific endpoint (parameters, exact price).
 * Safe for read-scope tokens — no cost, no side effects.
 */
export async function catalogGet(endpointId: string): Promise<TregCatalogGetResult> {
  return tregFetch<TregCatalogGetResult>("/v1/catalog/get", {
    endpoint_id: endpointId,
  });
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
  return tregFetch<TregCallResult>("/v1/call", {
    endpoint_id: endpointId,
    params,
  });
}

/**
 * Get the current Treg balance. WRITE-SCOPE — reveals spending info.
 */
export async function balance(): Promise<TregBalanceResult> {
  return tregFetch<TregBalanceResult>("/v1/balance");
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
