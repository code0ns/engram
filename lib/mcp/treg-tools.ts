/**
 * Treg MCP Tools
 *
 * Exposes Treg catalog and call operations as MCP tools that agents can use.
 * These tools proxy to the real Treg API at https://treg.to
 *
 * Tools:
 *   - tool_search: Search the Treg catalog for endpoints by what they DO
 *   - tool_get: Get full details about one catalog endpoint
 *   - tool_call: Call a catalog endpoint or team tool
 *   - tool_balance: Check the team's prepaid balance
 */

import {
  catalogSearch,
  catalogGet,
  call,
  getBalance,
  isTregConfigured,
  TregApiError,
  getTregMaxUsdPerCall,
} from "@/lib/treg";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = Record<string, any>;

export interface TregTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Args) => Promise<unknown>;
}

const s = (description: string) => ({ type: "string", description });

export const TREG_TOOLS: TregTool[] = [
  {
    name: "tool_search",
    description:
      "Search the Treg tool catalog for endpoints by what you want to DO. Returns matching endpoints with their id, name, provider, cost, and observed reliability metrics.\n\n" +
      "Use this to discover tools for a task — e.g. 'backlinks for a domain', 'tiktok profile', 'email finder'. " +
      "Results are ranked by relevance and measured success rate. Each result includes a hint for the next step (typically `tool_get` to inspect the endpoint).\n\n" +
      "Requires TREG_TOKEN to be set. Catalog search is open/free.",
    inputSchema: {
      type: "object",
      properties: {
        query: s("what you want to do — a few keywords beat a full sentence"),
        limit: { type: "number", description: "max results (default 25)" },
      },
      required: ["query"],
    },
    handler: async ({ query, limit }) => {
      if (!isTregConfigured()) {
        return { error: "Treg not configured. Set TREG_TOKEN environment variable." };
      }
      try {
        const result = await catalogSearch(String(query), typeof limit === "number" ? limit : 25);
        return {
          results: result.results.map((r) => ({
            id: r.id,
            name: r.name,
            provider: r.provider,
            description: r.description,
            cost_usd: r.cost?.usd,
            cost_type: r.cost?.type,
            cost_unit: r.cost?.unit,
            ok_rate: r.observed?.ok_rate,
            sample_size: r.observed?.sample_size,
            median_ms: r.observed?.median_ms,
            last_ok: r.observed?.last_ok,
          })),
          total: result.total,
          hints: result.hints ?? "Use tool_get with the endpoint id to see full parameters and call template.",
        };
      } catch (e) {
        if (e instanceof TregApiError) {
          return { error: e.message, detail: e.detail, status: e.status };
        }
        throw e;
      }
    },
  },
  {
    name: "tool_get",
    description:
      "Get full details about one Treg catalog endpoint: parameters, cost, response shape, sibling providers (same capability, different cost/reliability), and a paste-ready call template.\n\n" +
      "Call this after tool_search to inspect an endpoint before calling it. The `siblings` field shows alternative providers for price/reliability comparison.\n\n" +
      "Requires TREG_TOKEN to be set.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint_id: s("the endpoint id from tool_search results, e.g. 'tikhub.tiktok.user.profile'"),
      },
      required: ["endpoint_id"],
    },
    handler: async ({ endpoint_id }) => {
      if (!isTregConfigured()) {
        return { error: "Treg not configured. Set TREG_TOKEN environment variable." };
      }
      try {
        const endpoint = await catalogGet(String(endpoint_id));
        return {
          id: endpoint.id,
          name: endpoint.name,
          provider: endpoint.provider,
          description: endpoint.description,
          method: endpoint.method,
          path: endpoint.path,
          parameters: endpoint.parameters,
          request_body: endpoint.request_body,
          cost: endpoint.cost,
          observed: endpoint.observed,
          siblings: endpoint.siblings,
          call_template: endpoint.call_template,
          example_response: endpoint.example_response,
          strict_query: endpoint.strict_query,
          hints: "Use tool_call with this endpoint_id plus the required parameters to make the call.",
        };
      } catch (e) {
        if (e instanceof TregApiError) {
          return { error: e.message, detail: e.detail, status: e.status };
        }
        throw e;
      }
    },
  },
  {
    name: "tool_call",
    description:
      "Call a Treg catalog endpoint or team tool. Pass the endpoint_id and any required parameters (as query params or body).\n\n" +
      "For catalog endpoints: method is usually GET for lookups, POST for searches/actions. Check tool_get for the correct method.\n" +
      `Spend cap: calls are limited to $${TREG_MAX_USD_PER_CALL} by default (configurable via TREG_MAX_USD_PER_CALL). Calls exceeding this cap are refused with 402.\n\n` +
      "Response includes:\n" +
      "- `data`: the upstream response (verbatim from the provider)\n" +
      "- `cost_usd`: what was charged (from X-Treg-Cost-Micro header)\n" +
      "- `call_id`: store this for support/audit\n" +
      "- `cached`: true if served from cache (10% cost)\n" +
      "- `replayed`: true if this was an idempotent replay (no charge)\n\n" +
      "Requires TREG_TOKEN to be set.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint_id: s("the endpoint id, e.g. 'tikhub.tiktok.user.profile'"),
        method: s("HTTP method: GET, POST, PUT, DELETE, etc. (default: GET if no body, POST if body)"),
        query: { type: "object", description: "query parameters as key-value pairs" },
        body: { type: "object", description: "request body (JSON) — presence implies POST unless method is set" },
        idempotency_key: s("optional key for safe retries — same key = same response, no double charge"),
        max_cost_usd: { type: "number", description: `max cost for this call in USD (default: ${TREG_MAX_USD_PER_CALL})` },
      },
      required: ["endpoint_id"],
    },
    handler: async ({ endpoint_id, method, query, body, idempotency_key, max_cost_usd }) => {
      if (!isTregConfigured()) {
        return { error: "Treg not configured. Set TREG_TOKEN environment variable." };
      }
      try {
        const result = await call(String(endpoint_id), {
          method: method ? String(method) : undefined,
          query: query && typeof query === "object" ? (query as Record<string, string>) : undefined,
          body: body ?? undefined,
          idempotencyKey: idempotency_key ? String(idempotency_key) : undefined,
          maxCostUsd: typeof max_cost_usd === "number" ? max_cost_usd : undefined,
        });
        return {
          data: result.data,
          cost_usd: result.cost_usd,
          call_id: result.call_id,
          served_via: result.served_via,
          cached: result.cached,
          replayed: result.replayed,
        };
      } catch (e) {
        if (e instanceof TregApiError) {
          return { error: e.message, detail: e.detail, status: e.status };
        }
        throw e;
      }
    },
  },
  {
    name: "tool_balance",
    description:
      "Check the team's prepaid Treg balance. Returns the current balance in micro-USD and USD, any in-flight holds, and the available balance.\n\n" +
      "Amounts are returned as both micro-USD integers (`*_micro`) and display-only USD floats. Compute against the micro fields, not USD.\n\n" +
      "Requires TREG_TOKEN to be set. Also requires org context (either a per-org token or TREG_ORG_ID).",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      if (!isTregConfigured()) {
        return { error: "Treg not configured. Set TREG_TOKEN environment variable." };
      }
      try {
        const balance = await getBalance();
        return {
          balance_micro: balance.balance_micro,
          balance_usd: balance.balance_usd,
          holds_micro: balance.holds_micro,
          holds_usd: balance.holds_usd,
          available_micro: balance.available_micro,
          available_usd: balance.available_usd,
          org_id: balance.org_id,
          org_name: balance.org_name,
        };
      } catch (e) {
        if (e instanceof TregApiError) {
          return { error: e.message, detail: e.detail, status: e.status };
        }
        throw e;
      }
    },
  },
];

export const TREG_TOOL_MAP = new Map(TREG_TOOLS.map((t) => [t.name, t]));

/**
 * Get Treg tools that should be visible to callers.
 * Only returns tools when Treg is configured (TREG_TOKEN set).
 */
export function visibleTregTools(): TregTool[] {
  if (!isTregConfigured()) {
    return [];
  }
  return TREG_TOOLS;
}
