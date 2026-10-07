/**
 * Tool recipes — saved, known-good ways to call an external API endpoint.
 *
 * A recipe is an ordinary vault note under `tools/<provider>/` whose frontmatter records what an
 * agent needs to repeat a call without rediscovering it in the paid catalog: the Treg `endpoint`
 * id, the HTTP `method`, `price_usd`, a `params_example` that worked, and `last_verified`. Being a
 * plain note, it is searchable, versioned and editable like everything else in the vault.
 *
 * Recipes are saved deliberately (tool_recipe_save), never automatically after each tool_call:
 * every vault write becomes a git commit, so auto-saving would turn the history into a call log.
 */

import { getNote, listNotes, searchNotes } from "@/lib/vault/store";
import { writeNote } from "@/lib/vault/write";
import { effectiveAuthority, type Authority } from "@/lib/vault/authority";
import { normalizeHttpMethod, type HttpMethod } from "@/lib/treg";
import type { NoteMeta } from "@/lib/vault/types";

export const RECIPE_FOLDER = "tools";
export const RECIPE_TYPE = "tool-recipe";
/** A recipe not re-verified for this long may have a changed price or shape: re-check before calling. */
export const RECIPE_STALE_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Recipe {
  path: string;
  title: string;
  provider: string;
  /** The Treg endpoint id — pass it to tool_get / tool_call. */
  endpoint: string;
  method?: HttpMethod;
  price_usd?: number;
  params_example?: Record<string, unknown>;
  task?: string;
  /** YYYY-MM-DD */
  last_verified?: string;
  /** True when last_verified is missing or older than RECIPE_STALE_DAYS. */
  stale: boolean;
  authority: Authority;
}

export interface RecipeInput {
  provider: string;
  endpoint: string;
  method: string;
  price_usd: number;
  task: string;
  params_example?: Record<string, unknown>;
  title?: string;
  notes?: string;
  overwrite?: boolean;
  allowConflict?: boolean;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
}

/**
 * `tools/<provider>/<provider>-<endpoint>.md`. The provider is repeated in the filename because
 * wikilinks resolve by bare stem vault-wide: two providers' `search.md` would collide.
 */
export function recipePath(provider: string, endpoint: string): string {
  const p = slugify(provider);
  const e = slugify(endpoint);
  if (!p) throw new Error("provider is empty once reduced to a slug (letters, digits, hyphens).");
  if (!e) throw new Error("endpoint is empty once reduced to a slug (letters, digits, hyphens).");
  const stem = e === p || e.startsWith(`${p}-`) ? e : `${p}-${e}`;
  return `${RECIPE_FOLDER}/${p}/${stem}.md`;
}

function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** gray-matter turns an unquoted `2026-07-01` into a Date; a quoted one stays a string. Accept both. */
function dateString(v: unknown): string | undefined {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return v.slice(0, 10);
  return undefined;
}

export function isStale(lastVerified: string | undefined, now: number = Date.now()): boolean {
  if (!lastVerified) return true;
  return now - Date.parse(lastVerified) > RECIPE_STALE_DAYS * DAY_MS;
}

/** A note is a recipe when it lives under tools/ and names an endpoint. */
export function toRecipe(meta: NoteMeta, now: number = Date.now()): Recipe | null {
  if (meta.folder !== RECIPE_FOLDER) return null;
  const fm = meta.frontmatter ?? {};
  if (typeof fm.endpoint !== "string" || fm.endpoint.trim() === "") return null;
  const last = dateString(fm.last_verified);
  const params = fm.params_example;
  return {
    path: meta.path,
    title: meta.title,
    provider: typeof fm.provider === "string" ? fm.provider : meta.path.split("/")[1] ?? "",
    endpoint: fm.endpoint,
    method: normalizeHttpMethod(typeof fm.method === "string" ? fm.method : undefined),
    price_usd: typeof fm.price_usd === "number" ? fm.price_usd : undefined,
    params_example: params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : undefined,
    task: typeof fm.task === "string" ? fm.task : undefined,
    last_verified: last,
    stale: isStale(last, now),
    authority: effectiveAuthority(meta, now).authority,
  };
}

/** Saved recipes matching a task description, best first. Superseded/archived recipes are withheld. */
export function findRecipes(dir: string, query: string, limit = 10): Recipe[] {
  const { hits } = searchNotes(dir, query, { folder: RECIPE_FOLDER, limit: limit * 2, snippets: false });
  if (hits.length === 0) return [];
  const byPath = new Map(listNotes(dir).map((n) => [n.path, n]));
  const now = Date.now();
  const out: Recipe[] = [];
  for (const h of hits) {
    const meta = byPath.get(h.path);
    const r = meta ? toRecipe(meta, now) : null;
    if (r) out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/** The live recipe for a Treg endpoint id, if one has been saved. */
export function findRecipeByEndpoint(dir: string, endpoint: string): Recipe | null {
  const now = Date.now();
  for (const n of listNotes(dir)) {
    const r = toRecipe(n, now);
    if (r && r.endpoint === endpoint && !effectiveAuthority(n, now).retired) return r;
  }
  return null;
}

/**
 * Create or refresh a recipe. Re-saving the same provider + endpoint updates the note in place:
 * frontmatter fields are replaced, `last_verified` is set to today, and the body (the human notes)
 * is kept unless new `notes` are passed.
 */
export async function saveRecipe(dir: string, input: RecipeInput, now: number = Date.now()): Promise<{ path: string; created: boolean }> {
  const provider = String(input.provider ?? "").trim();
  const endpoint = String(input.endpoint ?? "").trim();
  const task = String(input.task ?? "").trim();
  const method = normalizeHttpMethod(input.method);
  if (!provider || !endpoint) throw new Error("provider and endpoint are required.");
  if (!task) throw new Error("task is required: one line on what this endpoint does, so tool_search can find it.");
  if (!method) throw new Error(`method must be one of GET, POST, PUT, PATCH, DELETE (got ${JSON.stringify(input.method)}).`);
  if (typeof input.price_usd !== "number" || !Number.isFinite(input.price_usd) || input.price_usd < 0) {
    throw new Error("price_usd must be a non-negative number (the per-call price from tool_get; 0 for free).");
  }
  if (input.params_example !== undefined && (typeof input.params_example !== "object" || input.params_example === null || Array.isArray(input.params_example))) {
    throw new Error("params_example must be an object of parameters that worked.");
  }

  const rel = recipePath(provider, endpoint);
  const existing = getNote(dir, rel);
  const prev = existing?.frontmatter ?? {};
  const prevTags = Array.isArray(prev.tags) ? prev.tags.map(String) : [];
  const tags = [...new Set([...prevTags, RECIPE_TYPE, slugify(provider)])];

  const frontmatter: Record<string, unknown> = {
    ...prev,
    title: input.title?.trim() || (typeof prev.title === "string" ? prev.title : `${task} (${provider})`),
    type: RECIPE_TYPE,
    tags,
    provider,
    endpoint,
    method,
    price_usd: input.price_usd,
    task,
    last_verified: today(now),
  };
  if (input.params_example !== undefined) frontmatter.params_example = input.params_example;

  const notes = input.notes?.trim();
  const body = notes ? `${task}\n\n${notes}\n` : existing?.body?.trim() ? existing.body : `${task}\n`;

  const path = await writeNote(dir, rel, body, frontmatter, {
    allowShrink: input.overwrite === true,
    allowConflict: input.allowConflict === true,
  });
  return { path, created: !existing };
}
