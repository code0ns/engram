/**
 * Treg API Client
 *
 * Proxies tool catalog operations to the real Treg API at https://treg.to
 *
 * See: https://treg.to/llms.txt and https://treg.to/openapi.json for the real API docs.
 */

export function getTregBaseUrl(): string {
  return process.env.TREG_BASE_URL || "https://treg.to";
}

export function getTregToken(): string {
  return process.env.TREG_TOKEN || "";
}

export function getTregOrgId(): string {
  return process.env.TREG_ORG_ID || "";
}

export function getTregMaxUsdPerCall(): number {
  return parseFloat(process.env.TREG_MAX_USD_PER_CALL || "1.0");
}

export interface TregConfig {
  baseUrl: string;
  token: string;
  orgId?: string;
  maxUsdPerCall?: number;
}

function getConfig(): TregConfig {
  return {
    baseUrl: getTregBaseUrl(),
    token: getTregToken(),
    orgId: getTregOrgId() || undefined,
    maxUsdPerCall: getTregMaxUsdPerCall(),
  };
}

export function isTregConfigured(): boolean {
  return getTregToken() !== "";
}

interface TregHeaders {
  "X-Treg-Token": string;
  "X-Treg-Org"?: string;
  "X-Treg-Route-Max-Cost"?: string;
  "Content-Type"?: string;
  "Idempotency-Key"?: string;
}

function makeHeaders(config: TregConfig, extraHeaders?: Record<string, string>): TregHeaders {
  const headers: TregHeaders = {
    "X-Treg-Token": config.token,
  };
  if (config.orgId) {
    headers["X-Treg-Org"] = config.orgId;
  }
  if (extraHeaders) {
    Object.assign(headers, extraHeaders);
  }
  return headers;
}

export interface TregError {
  error: string;
  detail?: string;
  status?: number;
}

export class TregApiError extends Error {
  status: number;
  detail?: string;

  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = "TregApiError";
    this.status = status;
    this.detail = detail;
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail: string | undefined;
    try {
      const body = await res.json();
      detail = body.detail || body.error || JSON.stringify(body);
    } catch {
      detail = await res.text().catch(() => undefined);
    }
    throw new TregApiError(`Treg API error: ${res.status} ${res.statusText}`, res.status, detail);
  }
  return res.json() as Promise<T>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalog Search
// GET https://treg.to/catalog/search?q=<query>&limit=<n>
// ─────────────────────────────────────────────────────────────────────────────

export interface CatalogSearchResult {
  id: string;
  name: string;
  provider: string;
  description?: string;
  cost?: {
    usd?: number;
    type?: string;
    unit?: string;
  };
  observed?: {
    ok_rate?: number;
    sample_size?: number;
    median_ms?: number;
    last_ok?: string;
  };
}

export interface CatalogSearchResponse {
  results: CatalogSearchResult[];
  total?: number;
  hints?: string;
}

export async function catalogSearch(query: string, limit = 25): Promise<CatalogSearchResponse> {
  const config = getConfig();
  const url = new URL("/catalog/search", config.baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: makeHeaders(config),
  });

  return handleResponse<CatalogSearchResponse>(res);
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalog Get (endpoint details)
// GET https://treg.to/catalog/endpoints/{endpoint_id}
// ─────────────────────────────────────────────────────────────────────────────

export interface CatalogEndpoint {
  id: string;
  name: string;
  provider: string;
  description?: string;
  method?: string;
  path?: string;
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    schema?: Record<string, unknown>;
    description?: string;
  }>;
  request_body?: Record<string, unknown>;
  cost?: {
    usd?: number;
    type?: string;
    unit?: string;
    price_source?: string;
  };
  observed?: {
    ok_rate?: number;
    sample_size?: number;
    median_ms?: number;
    last_ok?: string;
  };
  siblings?: Array<{
    id: string;
    provider: string;
    cost_usd?: number;
    ok_rate?: number;
  }>;
  call_template?: string;
  example_response?: unknown;
  strict_query?: boolean;
}

export async function catalogGet(endpointId: string): Promise<CatalogEndpoint> {
  const config = getConfig();
  const url = new URL(`/catalog/endpoints/${encodeURIComponent(endpointId)}`, config.baseUrl);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: makeHeaders(config),
  });

  return handleResponse<CatalogEndpoint>(res);
}

// ─────────────────────────────────────────────────────────────────────────────
// Call
// https://treg.to/call/{endpoint_id}
// Method/query/body depend on the endpoint being called.
// ─────────────────────────────────────────────────────────────────────────────

export interface CallOptions {
  method?: string;
  query?: Record<string, string>;
  body?: unknown;
  idempotencyKey?: string;
  maxCostUsd?: number;
}

export interface CallResponse {
  data: unknown;
  cost_usd?: number;
  call_id?: string;
  served_via?: string;
  cached?: boolean;
  replayed?: boolean;
}

export async function call(endpointId: string, options: CallOptions = {}): Promise<CallResponse> {
  const config = getConfig();
  const maxCost = options.maxCostUsd ?? config.maxUsdPerCall;

  const url = new URL(`/call/${encodeURIComponent(endpointId)}`, config.baseUrl);
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) {
      url.searchParams.set(k, v);
    }
  }

  const extraHeaders: Record<string, string> = {};
  if (maxCost !== undefined) {
    extraHeaders["X-Treg-Route-Max-Cost"] = String(maxCost);
  }
  if (options.idempotencyKey) {
    extraHeaders["Idempotency-Key"] = options.idempotencyKey;
  }
  if (options.body) {
    extraHeaders["Content-Type"] = "application/json";
  }

  const method = options.method?.toUpperCase() || (options.body ? "POST" : "GET");

  const res = await fetch(url.toString(), {
    method,
    headers: makeHeaders(config, extraHeaders),
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const costHeader = res.headers.get("X-Treg-Cost-Micro");
  const callIdHeader = res.headers.get("X-Treg-Call-Id");
  const servedViaHeader = res.headers.get("X-Treg-Served-Via");
  const cacheHeader = res.headers.get("X-Treg-Cache");
  const replayedHeader = res.headers.get("X-Treg-Idempotent-Replay");

  const data = await handleResponse<unknown>(res);

  return {
    data,
    cost_usd: costHeader ? parseInt(costHeader, 10) / 1_000_000 : undefined,
    call_id: callIdHeader ?? undefined,
    served_via: servedViaHeader ?? undefined,
    cached: cacheHeader === "hit",
    replayed: replayedHeader === "true",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Balance
// GET https://treg.to/orgs/{org_id}/balance
// Requires org context — derived from token or explicit org_id.
// ─────────────────────────────────────────────────────────────────────────────

export interface BalanceResponse {
  balance_micro: number;
  balance_usd: number;
  holds_micro?: number;
  holds_usd?: number;
  available_micro?: number;
  available_usd?: number;
  org_id?: number;
  org_name?: string;
}

export async function getBalance(): Promise<BalanceResponse> {
  const config = getConfig();

  if (!config.orgId) {
    const me = await getMe();
    if (!me.org_id) {
      throw new TregApiError(
        "Cannot fetch balance: no org_id available. Set TREG_ORG_ID or use a per-org token.",
        400,
      );
    }
    config.orgId = String(me.org_id);
  }

  const url = new URL(`/orgs/${config.orgId}/balance`, config.baseUrl);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: makeHeaders(config),
  });

  return handleResponse<BalanceResponse>(res);
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth/Me - get current user/org context
// GET https://treg.to/auth/me
// ─────────────────────────────────────────────────────────────────────────────

export interface MeResponse {
  user_id?: number;
  email?: string;
  org_id?: number;
  org_name?: string;
  role?: string;
}

export async function getMe(): Promise<MeResponse> {
  const config = getConfig();
  const url = new URL("/auth/me", config.baseUrl);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: makeHeaders(config),
  });

  return handleResponse<MeResponse>(res);
}

// ─────────────────────────────────────────────────────────────────────────────
// My Tools - list tools registered by the team
// GET https://treg.to/tools
// ─────────────────────────────────────────────────────────────────────────────

export interface TeamTool {
  name: string;
  base_url?: string;
  host?: string;
  bindings?: Array<{
    location?: string;
    name?: string;
    format?: string;
  }>;
}

export async function getMyTools(): Promise<TeamTool[]> {
  const config = getConfig();
  const url = new URL("/tools", config.baseUrl);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: makeHeaders(config),
  });

  return handleResponse<TeamTool[]>(res);
}
