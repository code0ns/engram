/**
 * Treg MCP tools — expose Treg's external API catalog through Engram's MCP.
 *
 * Scope rules (match existing Engram patterns):
 *   read  — tool_search, tool_get (discovery only, no cost)
 *   write — tool_call, tool_balance (spend money or reveal balance)
 *
 * When TREG_TOKEN is unset, these tools are hidden entirely (not just erroring).
 */

import {
  catalogSearch,
  catalogGet,
  call,
  balance,
  TREG_MAX_USD_PER_CALL,
  logTregCall,
  type HttpMethod,
} from "@/lib/treg";
import type { Tool, ToolCtx } from "./tools";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = Record<string, any>;

const s = (description: string) => ({ type: "string", description });

export const TREG_TOOLS: Tool[] = [
  {
    name: "tool_search",
    description:
      "Search Treg's catalog of 2,600+ external API endpoints. Describe the TASK you want to do (e.g. 'get weather forecast', 'lookup company info', 'generate an image'), not a vendor name. " +
      "Returns endpoints with their `endpoint_id`, price (`usd_per_call`), reliability score, and whether they need a key. " +
      "WORKFLOW: search → inspect with tool_get → call with tool_call. Always check the price before calling.",
    inputSchema: {
      type: "object",
      properties: {
        query: s("Task description — what you want to do (e.g. 'reverse geocode coordinates', 'enrich company by domain')"),
        limit: { type: "number", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
    handler: async ({ query, limit }: Args, _ctx: ToolCtx) => {
      try {
        const result = await catalogSearch(String(query), typeof limit === "number" ? limit : undefined);
        logTregCall("search", { success: true });
        return {
          endpoints: result.results.map((e) => ({
            endpoint_id: e.id,
            provider: e.provider,
            name: e.name,
            description: e.summary,
            // Treg returns cost in multiple possible locations: cost.usd or top-level usd_per_call
            usd_per_call: e.cost?.usd ?? e.usd_per_call,
            no_key_needed: e.platform_eligible,
            reliability: e.observed?.ok_rate,
          })),
          total: result.total,
          hint: "Use tool_get(endpoint_id) to see full parameters and exact price before calling.",
        };
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        logTregCall("search", { success: false, error: msg });
        throw e;
      }
    },
  },
  {
    name: "tool_get",
    description:
      "Get full details for a Treg endpoint: parameters, response schema, and exact price. " +
      "Call this before tool_call to understand what arguments the endpoint needs and confirm the cost.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint_id: s("The endpoint ID from tool_search results"),
      },
      required: ["endpoint_id"],
    },
    handler: async ({ endpoint_id }: Args, _ctx: ToolCtx) => {
      try {
        const result = await catalogGet(String(endpoint_id));
        logTregCall("get", { endpointId: String(endpoint_id), success: true });
        // Treg returns cost in multiple possible locations: cost.usd or top-level usd_per_call
        const usdPerCall = result.cost?.usd ?? result.usd_per_call ?? 0;
        return {
          endpoint_id: result.id,
          provider: result.provider,
          name: result.name,
          description: result.summary,
          usd_per_call: usdPerCall,
          no_key_needed: result.platform_eligible,
          reliability: result.observed?.ok_rate,
          parameters: result.input,
          call_template: result.call_template,
          siblings: result.siblings,
          hint:
            usdPerCall > TREG_MAX_USD_PER_CALL
              ? `WARNING: This endpoint costs $${usdPerCall.toFixed(4)}/call, which exceeds the cap of $${TREG_MAX_USD_PER_CALL.toFixed(4)}. tool_call will refuse it unless the operator raises TREG_MAX_USD_PER_CALL.`
              : `Price $${usdPerCall.toFixed(4)}/call — within the allowed cap.`,
        };
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        logTregCall("get", { endpointId: String(endpoint_id), success: false, error: msg });
        throw e;
      }
    },
  },
  {
    name: "tool_call",
    write: true,
    description:
      `Call a Treg endpoint. THIS COSTS MONEY — the Engram operator's Treg balance is charged. ` +
      `Calls exceeding $${TREG_MAX_USD_PER_CALL.toFixed(4)} are refused; ask the operator for approval or to raise TREG_MAX_USD_PER_CALL. ` +
      `Always use tool_get first to confirm the price and required parameters. ` +
      `The HTTP method (GET/POST) is determined from the catalog; for GET endpoints, params are sent as query string, not JSON body.`,
    inputSchema: {
      type: "object",
      properties: {
        endpoint_id: s("The endpoint ID to call"),
        params: { type: "object", description: "Parameters for the endpoint (see tool_get for schema)" },
        estimated_usd: { type: "number", description: "Expected cost from tool_get — used to enforce the spending cap" },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          description: "Override HTTP method (optional — normally auto-detected from catalog)",
        },
      },
      required: ["endpoint_id", "params"],
    },
    handler: async ({ endpoint_id, params, estimated_usd, method }: Args, _ctx: ToolCtx) => {
      const eid = String(endpoint_id);
      const p = typeof params === "object" && params !== null ? params : {};
      const est = typeof estimated_usd === "number" ? estimated_usd : undefined;
      const methodOverride = typeof method === "string" ? (method.toUpperCase() as HttpMethod) : undefined;

      try {
        const result = await call(eid, p, { estimatedUsd: est, method: methodOverride });
        logTregCall("call", { endpointId: eid, usdEstimate: est, success: true });
        return {
          data: result.data,
          call_id: result.call_id,
          usd_charged: result.cost_usd,
        };
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        logTregCall("call", { endpointId: eid, usdEstimate: est, success: false, error: msg });
        throw e;
      }
    },
  },
  {
    name: "tool_balance",
    write: true,
    description:
      "Check the Treg account balance. Write-scope only because it reveals spending information. " +
      "Use to verify funds before a batch of calls.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args: Args, _ctx: ToolCtx) => {
      try {
        const result = await balance();
        logTregCall("balance", { success: true });
        return {
          balance_usd: result.balance_usd,
          balance_micro: result.balance_micro,
          in_flight_micro: result.in_flight_micro,
          currency: result.currency ?? "USD",
        };
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        logTregCall("balance", { success: false, error: msg });
        throw e;
      }
    },
  },
];

export const TREG_TOOL_MAP = new Map(TREG_TOOLS.map((t) => [t.name, t]));
