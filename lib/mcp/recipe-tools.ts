/**
 * Recipe tools — saved, known-good API calls (lib/recipes.ts), searched before the paid catalog.
 *
 *   read  — tool_search: saved recipes first, then Treg's catalog when the workspace has a token
 *   write — tool_recipe_save: record a recipe as a note under tools/<provider>/
 *
 * Unlike the Treg tools these are always visible: recipes are vault notes, so finding the ones a
 * workspace has saved should not depend on whether it currently has a Treg token.
 */

import { catalogSearch, logTregCall, resolveTregConfig, tregEnabled } from "@/lib/treg";
import { findRecipes, saveRecipe, RECIPE_STALE_DAYS, type Recipe } from "@/lib/recipes";
import type { Tool, ToolCtx } from "./tools";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = Record<string, any>;

const s = (description: string) => ({ type: "string", description });

const wsOf = (ctx: ToolCtx) => ctx.workspaceId ?? null;

function recipeHint(recipes: Recipe[]): string {
  if (recipes.length === 0) return "";
  const stale = recipes.filter((r) => r.stale).length;
  return (
    "Saved recipes come first: each `endpoint` is a Treg endpoint_id you can pass straight to tool_call with `params_example` as a starting point. " +
    (stale > 0
      ? `${stale} recipe(s) are stale (not verified in ${RECIPE_STALE_DAYS} days) — confirm price and params with tool_get before calling. `
      : "")
  );
}

export const RECIPE_TOOLS: Tool[] = [
  {
    name: "tool_search",
    description:
      "Find an external API endpoint for a TASK (e.g. 'get weather forecast', 'enrich company by domain'), not a vendor name. " +
      "Searches this workspace's SAVED RECIPES first (notes under tools/, written with tool_recipe_save): known-good endpoints with method, price and a params example that worked. " +
      "Only when no recipe matches (or with include_catalog: true) does it also search Treg's catalog of 2,600+ endpoints, and only if this workspace has a Treg token. " +
      "WORKFLOW: search → (catalog hits: inspect with tool_get) → tool_call. Always check the price before calling.",
    inputSchema: {
      type: "object",
      properties: {
        query: s("Task description — what you want to do (e.g. 'reverse geocode coordinates', 'enrich company by domain')"),
        limit: { type: "number", description: "Max results per source (default 10)" },
        include_catalog: {
          type: "boolean",
          description: "Also search the Treg catalog even when saved recipes match (default false)",
        },
      },
      required: ["query"],
    },
    handler: async ({ query, limit, include_catalog }: Args, ctx: ToolCtx) => {
      const q = String(query);
      const n = typeof limit === "number" && limit > 0 ? limit : 10;
      const recipes = findRecipes(ctx.dir, q, n);

      const cfg = resolveTregConfig(wsOf(ctx));
      const catalogOn = tregEnabled(cfg);
      const searchCatalog = catalogOn && (recipes.length === 0 || include_catalog === true);

      if (!searchCatalog) {
        const catalog = catalogOn
          ? "skipped — saved recipes matched; pass include_catalog: true to also search it"
          : "unavailable — this workspace has no Treg token, so only saved recipes are searched";
        const none = recipes.length === 0 ? "No saved recipe matches this task. " : "";
        return { recipes, endpoints: [], catalog, hint: `${none}${recipeHint(recipes)}`.trim() };
      }

      try {
        const result = await catalogSearch(cfg, q, n);
        logTregCall("search", { success: true, workspace: cfg.ledgerKey });
        return {
          recipes,
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
          catalog: "searched",
          hint:
            recipeHint(recipes) +
            "For catalog endpoints, use tool_get(endpoint_id) to see full parameters and exact price before calling. " +
            "If you will reuse one, save it afterwards with tool_recipe_save.",
        };
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        logTregCall("search", { success: false, error: msg, workspace: cfg.ledgerKey });
        // A catalog outage shouldn't hide recipes that already answer the question.
        if (recipes.length === 0) throw e;
        return { recipes, endpoints: [], catalog: `error — ${msg}`, hint: recipeHint(recipes).trim() };
      }
    },
  },
  {
    name: "tool_recipe_save",
    write: true,
    description:
      "Save a known-good external API call as a recipe, so the next tool_search finds it without searching the paid catalog. " +
      "Writes a note to tools/<provider>/ with the endpoint, method, price, a params example and today's date as last_verified. " +
      "Re-saving the same provider + endpoint refreshes it in place (keeps its notes unless you pass new ones). " +
      "Save only endpoints you expect to reuse, AFTER a call worked — never after every call: each save is a git commit in the vault.",
    inputSchema: {
      type: "object",
      properties: {
        provider: s("API provider, e.g. 'openweather' — becomes the folder tools/<provider>/"),
        endpoint: s("The Treg endpoint_id you called (what tool_call takes)"),
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "HTTP method" },
        price_usd: { type: "number", description: "Per-call price in USD from tool_get (0 if free)" },
        task: s("One line: what this endpoint does, phrased like a tool_search query (e.g. 'daily weather forecast by city')"),
        params_example: { type: "object", description: "Parameters that worked, as passed to tool_call" },
        title: s("Optional note title (default: '<task> (<provider>)')"),
        notes: s("Optional markdown: gotchas, response shape, rate limits"),
        overwrite: { type: "boolean", description: "confirm replacing a recipe's long notes with much shorter ones (default false)" },
        allow_conflict: { type: "boolean", description: "confirm a near-duplicate recipe note is deliberate (default false)" },
      },
      required: ["provider", "endpoint", "method", "price_usd", "task"],
    },
    handler: async (a: Args, ctx: ToolCtx) => {
      const r = await saveRecipe(ctx.dir, {
        provider: a.provider,
        endpoint: a.endpoint,
        method: a.method,
        price_usd: a.price_usd,
        task: a.task,
        params_example: a.params_example,
        title: typeof a.title === "string" ? a.title : undefined,
        notes: typeof a.notes === "string" ? a.notes : undefined,
        overwrite: a.overwrite === true,
        allowConflict: a.allow_conflict === true,
      });
      return { ok: true, ...r };
    },
  },
];

export const RECIPE_TOOL_MAP = new Map(RECIPE_TOOLS.map((t) => [t.name, t]));
