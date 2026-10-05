/**
 * Treg MCP tools — expose Treg's external API catalog through Engram's MCP.
 *
 * Scope rules (match existing Engram patterns):
 *   read  — tool_get (discovery only, no cost)
 *   write — tool_call, tool_balance (spend money or reveal balance)
 *
 * tool_search lives in recipe-tools.ts: it searches saved recipes before this catalog, and stays
 * visible without a Treg token so those recipes remain findable.
 *
 * Credentials and spend limits are per workspace (lib/treg-config.ts): each handler resolves the
 * config for the workspace the call landed in. A workspace with no token of its own falls back to
 * the shared env token. When neither exists the tools are hidden entirely (visibleTools).
 */

import {
  catalogGet,
  catalogPriceUsd,
  call,
  balance,
  logTregCall,
  resolveTregConfig,
  spentToday,
  type HttpMethod,
} from "@/lib/treg";
import { findRecipeByEndpoint, RECIPE_STALE_DAYS } from "@/lib/recipes";
import type { Tool, ToolCtx } from "./tools";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = Record<string, any>;

const s = (description: string) => ({ type: "string", description });

const wsOf = (ctx: ToolCtx) => ctx.workspaceId ?? null;

/**
 * After a successful call: nudge toward saving a recipe, but only when there's something to gain.
 * Never save automatically — each vault write is a git commit.
 */
function recipeNudge(dir: string, endpointId: string): string | undefined {
  const r = findRecipeByEndpoint(dir, endpointId);
  if (!r) {
    return "If you will call this endpoint again, save it with tool_recipe_save so tool_search finds it without the catalog. Skip it for one-off calls: every save is a git commit.";
  }
  if (r.stale) {
    return `Recipe ${r.path} was last verified ${r.last_verified ?? "never"} (over ${RECIPE_STALE_DAYS} days ago). This call worked, so re-save it with tool_recipe_save to refresh last_verified and the price.`;
  }
  return undefined;
}

export const TREG_TOOLS: Tool[] = [
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
    handler: async ({ endpoint_id }: Args, ctx: ToolCtx) => {
      const cfg = resolveTregConfig(wsOf(ctx));
      try {
        const result = await catalogGet(cfg, String(endpoint_id));
        logTregCall("get", { endpointId: String(endpoint_id), success: true, workspace: cfg.ledgerKey });
        const usdPerCall = catalogPriceUsd(result) ?? 0;
        const spent = spentToday(cfg.ledgerKey);
        const remaining = Math.max(0, cfg.dailyCapUsd - spent);
        let hint: string;
        if (usdPerCall > cfg.perCallCapUsd) {
          hint = `WARNING: This endpoint costs $${usdPerCall.toFixed(4)}/call, which exceeds this workspace's per-call cap of $${cfg.perCallCapUsd.toFixed(4)}. tool_call will refuse it unless a workspace admin raises the cap.`;
        } else if (usdPerCall > remaining) {
          hint = `WARNING: This endpoint costs $${usdPerCall.toFixed(4)}/call but only $${remaining.toFixed(4)} is left of today's $${cfg.dailyCapUsd.toFixed(4)} daily cap. tool_call will refuse it.`;
        } else {
          hint = `Price $${usdPerCall.toFixed(4)}/call — within the per-call cap ($${cfg.perCallCapUsd.toFixed(4)}); $${remaining.toFixed(4)} left of today's daily cap.`;
        }
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
          hint,
        };
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        logTregCall("get", { endpointId: String(endpoint_id), success: false, error: msg, workspace: cfg.ledgerKey });
        throw e;
      }
    },
  },
  {
    name: "tool_call",
    write: true,
    description:
      "Call a Treg endpoint. THIS COSTS MONEY — this workspace's Treg balance is charged. " +
      "Calls above the workspace's per-call cap, or that would push today's spend over its daily cap, are refused; ask a workspace admin to raise the cap or get human approval. " +
      "Always use tool_get first to confirm the price and required parameters. " +
      "The HTTP method (GET/POST) is determined from the catalog; for GET endpoints, params are sent as query string, not JSON body.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint_id: s("The endpoint ID to call"),
        params: { type: "object", description: "Parameters for the endpoint (see tool_get for schema)" },
        estimated_usd: { type: "number", description: "Expected cost from tool_get. Advisory — the catalog price is what is enforced." },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          description: "Override HTTP method (optional — normally auto-detected from catalog)",
        },
      },
      required: ["endpoint_id", "params"],
    },
    handler: async ({ endpoint_id, params, estimated_usd, method }: Args, ctx: ToolCtx) => {
      const cfg = resolveTregConfig(wsOf(ctx));
      const eid = String(endpoint_id);
      const p = typeof params === "object" && params !== null ? params : {};
      const est = typeof estimated_usd === "number" ? estimated_usd : undefined;
      const methodOverride = typeof method === "string" ? (method.toUpperCase() as HttpMethod) : undefined;

      try {
        const result = await call(cfg, eid, p, { estimatedUsd: est, method: methodOverride });
        logTregCall("call", { endpointId: eid, usdEstimate: result.cost_usd, success: true, workspace: cfg.ledgerKey });
        const hint = recipeNudge(ctx.dir, eid);
        return {
          data: result.data,
          call_id: result.call_id,
          usd_charged: result.cost_usd,
          ...(hint ? { hint } : {}),
        };
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        logTregCall("call", { endpointId: eid, usdEstimate: est, success: false, error: msg, workspace: cfg.ledgerKey });
        throw e;
      }
    },
  },
  {
    name: "tool_balance",
    write: true,
    description:
      "Check the Treg account balance for this workspace's token. Write-scope only because it reveals spending information. " +
      "Use to verify funds before a batch of calls.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args: Args, ctx: ToolCtx) => {
      const cfg = resolveTregConfig(wsOf(ctx));
      try {
        const result = await balance(cfg);
        logTregCall("balance", { success: true, workspace: cfg.ledgerKey });
        return {
          balance_usd: result.balance_usd,
          balance_micro: result.balance_micro,
          in_flight_micro: result.in_flight_micro,
          currency: result.currency ?? "USD",
          spent_today_usd: spentToday(cfg.ledgerKey),
          daily_cap_usd: cfg.dailyCapUsd,
        };
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        logTregCall("balance", { success: false, error: msg, workspace: cfg.ledgerKey });
        throw e;
      }
    },
  },
];

export const TREG_TOOL_MAP = new Map(TREG_TOOLS.map((t) => [t.name, t]));
