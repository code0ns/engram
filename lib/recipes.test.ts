import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { findRecipeByEndpoint, findRecipes, isStale, recipePath, saveRecipe, toRecipe, RECIPE_STALE_DAYS } from "./recipes";
import { getNote, refreshPaths } from "@/lib/vault/store";
import { RECIPE_TOOL_MAP } from "@/lib/mcp/recipe-tools";
import { resolveTregConfig, tregEnabled } from "@/lib/treg";
import type { NoteMeta } from "@/lib/vault/types";

// The shared test vault (test/setup.ts). Providers here are prefixed "zzr-" so no other suite's
// notes can match these queries.
const vault = process.env.VAULT_DIR!;
const DAY = 24 * 60 * 60 * 1000;

const base = {
  provider: "zzr-weather",
  endpoint: "zzr-weather.forecast-daily",
  method: "get",
  price_usd: 0.0004,
  task: "Daily frobnicated forecast by city",
  params_example: { city: "Riga", days: 3 },
};

function meta(over: Partial<NoteMeta> & { frontmatter: Record<string, unknown> }): NoteMeta {
  return { path: "tools/p/p-x.md", slug: "p-x", title: "X", folder: "tools", tags: [], aliases: [], mtimeMs: 0, ...over };
}

describe("recipePath", () => {
  test("puts the recipe under tools/<provider>/ and repeats the provider in the stem", () => {
    expect(recipePath("OpenWeather", "forecast")).toBe("tools/openweather/openweather-forecast.md");
  });

  test("does not double a provider prefix the endpoint id already carries", () => {
    expect(recipePath("diffbot", "diffbot.x.extract-article")).toBe("tools/diffbot/diffbot-x-extract-article.md");
  });

  test("refuses names that reduce to nothing", () => {
    expect(() => recipePath("!!!", "x")).toThrow(/provider/);
    expect(() => recipePath("p", "...")).toThrow(/endpoint/);
  });
});

describe("staleness", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");

  test("a recipe verified within the window is fresh; older or missing is stale", () => {
    expect(isStale(new Date(now - 10 * DAY).toISOString().slice(0, 10), now)).toBe(false);
    expect(isStale(new Date(now - (RECIPE_STALE_DAYS + 2) * DAY).toISOString().slice(0, 10), now)).toBe(true);
    expect(isStale(undefined, now)).toBe(true);
  });

  test("an unquoted YAML date (parsed to a Date) reads the same as a quoted string", () => {
    const asDate = toRecipe(meta({ frontmatter: { endpoint: "e", last_verified: new Date("2026-10-01") } }), now);
    const asString = toRecipe(meta({ frontmatter: { endpoint: "e", last_verified: "2026-10-01" } }), now);
    expect(asDate?.last_verified).toBe("2026-10-01");
    expect(asString?.last_verified).toBe("2026-10-01");
    expect(asDate?.stale).toBe(false);
  });

  test("only notes under tools/ that name an endpoint are recipes", () => {
    expect(toRecipe(meta({ folder: "docs", frontmatter: { endpoint: "e" } }))).toBeNull();
    expect(toRecipe(meta({ frontmatter: { provider: "p" } }))).toBeNull();
  });
});

describe("saveRecipe", () => {
  test("writes the frontmatter fields and stamps last_verified with today", async () => {
    const now = Date.parse("2026-10-06T09:00:00Z");
    const r = await saveRecipe(vault, base, now);
    expect(r).toEqual({ path: "tools/zzr-weather/zzr-weather-forecast-daily.md", created: true });

    const fm = getNote(vault, r.path)!.frontmatter;
    expect(fm.endpoint).toBe("zzr-weather.forecast-daily");
    expect(fm.method).toBe("GET");
    expect(fm.price_usd).toBe(0.0004);
    expect(fm.params_example).toEqual({ city: "Riga", days: 3 });
    expect(fm.type).toBe("tool-recipe");
    expect(fm.tags).toEqual(["tool-recipe", "zzr-weather"]);
    expect(String(fm.last_verified).slice(0, 10)).toBe("2026-10-06");
  });

  test("re-saving updates in place and keeps the human notes", async () => {
    const first = await saveRecipe(vault, { ...base, endpoint: "zzr-weather.hourly", notes: "Rate limited to 60/min." });
    const again = await saveRecipe(vault, { ...base, endpoint: "zzr-weather.hourly", price_usd: 0.0009 });
    expect(again).toEqual({ path: first.path, created: false });
    const n = getNote(vault, first.path)!;
    expect(n.frontmatter.price_usd).toBe(0.0009);
    expect(n.body).toContain("Rate limited to 60/min.");
  });

  test("rejects a recipe missing what makes it repeatable", async () => {
    await expect(saveRecipe(vault, { ...base, method: "FETCH" })).rejects.toThrow(/method/);
    await expect(saveRecipe(vault, { ...base, price_usd: -1 })).rejects.toThrow(/price_usd/);
    await expect(saveRecipe(vault, { ...base, task: " " })).rejects.toThrow(/task/);
    await expect(
      saveRecipe(vault, { ...base, params_example: [1, 2] as unknown as Record<string, unknown> }),
    ).rejects.toThrow(/params_example/);
  });
});

describe("finding recipes", () => {
  test("a task query finds the saved recipe", async () => {
    await saveRecipe(vault, { ...base, endpoint: "zzr-weather.alerts", task: "Severe quuxstorm alerts by region" });
    const hits = findRecipes(vault, "quuxstorm alerts");
    expect(hits.map((h) => h.endpoint)).toContain("zzr-weather.alerts");
    expect(hits[0].method).toBe("GET");
  });

  test("findRecipeByEndpoint ignores a superseded recipe", async () => {
    const { path: rel } = await saveRecipe(vault, { ...base, provider: "zzr-old", endpoint: "zzr-old.lookup", task: "Old lookup" });
    expect(findRecipeByEndpoint(vault, "zzr-old.lookup")?.path).toBe(rel);

    const abs = path.join(vault, rel);
    fs.writeFileSync(abs, fs.readFileSync(abs, "utf8").replace(/^---\n/, "---\nstatus: superseded\n"), "utf8");
    refreshPaths(vault, [rel]);
    expect(findRecipeByEndpoint(vault, "zzr-old.lookup")).toBeNull();
  });
});

describe("tool_search", () => {
  const search = RECIPE_TOOL_MAP.get("tool_search")!;
  const ctx = { dir: vault, workspaceId: "recipes-test-ws" };

  test("is read-scope and tool_recipe_save is write-scope", () => {
    expect(search.write).toBeFalsy();
    expect(RECIPE_TOOL_MAP.get("tool_recipe_save")?.write).toBe(true);
  });

  test("returns matching recipes and skips the catalog when one matches", async () => {
    await saveRecipe(vault, { ...base, endpoint: "zzr-weather.pollen", task: "Pollen zizzle index by city" });
    const out = (await search.handler({ query: "pollen zizzle" }, ctx)) as {
      recipes: Array<{ endpoint: string }>;
      endpoints: unknown[];
      catalog: string;
    };
    expect(out.recipes.map((r) => r.endpoint)).toContain("zzr-weather.pollen");
    expect(out.endpoints).toEqual([]);
    expect(out.catalog).toMatch(/^(skipped|unavailable)/);
  });

  test("without a Treg token it still answers, from recipes only", async () => {
    if (tregEnabled(resolveTregConfig(ctx.workspaceId))) return; // a dev env token would hit the network
    const out = (await search.handler({ query: "nothing saved matches xyzzyplugh" }, ctx)) as {
      recipes: unknown[];
      catalog: string;
      hint: string;
    };
    expect(out.recipes).toEqual([]);
    expect(out.catalog).toMatch(/^unavailable/);
    expect(out.hint).toMatch(/No saved recipe/);
  });
});
