import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "@/lib/config";

// App state (token hashes) lives in the fixed data dir, separate from any vault content.
const STATE_DIR = process.env.ENGRAM_STATE_DIR || DATA_ROOT;
const TOKENS_FILE = path.join(STATE_DIR, "tokens.json");

/**
 * What a token is allowed to do.
 *
 * `read`  — search, read, list, tree, backlinks, graph, recent, schema.
 * `write` — everything, including move and delete.
 *
 * This, not the Curator, is the lever that decides whether an agent can mutate the vault.
 * A read-only token is the guarantee that a connected agent cannot change your notes.
 */
export type TokenScope = "read" | "write";

interface StoredToken {
  id: string;
  name: string;
  hash: string;
  created: string;
  /** Absent on tokens created before scopes existed — those are grandfathered as `write`. */
  scope?: TokenScope;
  /**
   * The workspaces this token can access. Absent on tokens created before workspace
   * permissions existed — those are resolved to the legacy global default workspace by
   * lib/workspace-resolve.ts and shown as "unscoped — legacy" in the UI, so nothing that
   * already worked silently breaks.
   * 
   * Legacy: `workspaceId` (singular) is still read for backward compatibility but new
   * tokens always use `workspaceIds` (plural).
   */
  workspaceId?: string;
  workspaceIds?: string[];
}

export interface TokenMeta {
  id: string;
  name: string;
  created: string;
  scope: TokenScope;
  /** Array of workspace IDs this token can access. Empty array means unscoped (legacy). */
  workspaceIds: string[];
}

const hash = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function load(): StoredToken[] {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function save(tokens: StoredToken[]) {
  ensureStateDir();
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

/** Tokens minted before scopes existed keep the behaviour they had: full access. */
const scopeOf = (t: StoredToken): TokenScope => t.scope ?? "write";

/** Normalize workspace IDs from legacy single or new array format. */
function workspaceIdsOf(t: StoredToken): string[] {
  if (t.workspaceIds && t.workspaceIds.length > 0) return t.workspaceIds;
  if (t.workspaceId) return [t.workspaceId];
  return [];
}

export function listTokens(): TokenMeta[] {
  return load().map((t) => ({ id: t.id, name: t.name, created: t.created, scope: scopeOf(t), workspaceIds: workspaceIdsOf(t) }));
}

/** Create a token. Returns the plaintext value ONCE — only the hash is stored. */
export function createToken(
  name: string,
  scope: TokenScope = "write",
  workspaceIds?: string[],
): { id: string; name: string; scope: TokenScope; workspaceIds: string[]; token: string } {
  const token = crypto.randomBytes(32).toString("hex");
  const ids = workspaceIds?.filter(Boolean) ?? [];
  const rec: StoredToken = {
    id: crypto.randomUUID(),
    name: name?.trim() || "token",
    hash: hash(token),
    created: new Date().toISOString(),
    scope: scope === "read" ? "read" : "write",
    workspaceIds: ids.length > 0 ? ids : undefined,
  };
  const all = load();
  all.push(rec);
  save(all);
  return { id: rec.id, name: rec.name, scope: rec.scope!, workspaceIds: ids, token };
}

export function revokeToken(id: string): void {
  save(load().filter((t) => t.id !== id));
}

/** Update a token's workspace assignments. */
export function updateToken(id: string, workspaceIds: string[]): TokenMeta | null {
  const all = load();
  const idx = all.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const ids = workspaceIds?.filter(Boolean) ?? [];
  all[idx].workspaceIds = ids.length > 0 ? ids : undefined;
  delete all[idx].workspaceId; // Clear legacy field
  save(all);
  const t = all[idx];
  return { id: t.id, name: t.name, created: t.created, scope: scopeOf(t), workspaceIds: workspaceIdsOf(t) };
}

/** Resolve a bearer token to its identity + scope, or null when unknown. */
export function resolveToken(bearer: string): TokenMeta | null {
  if (!bearer) return null;
  const h = hash(bearer);
  const t = load().find((x) => x.hash === h);
  return t ? { id: t.id, name: t.name, created: t.created, scope: scopeOf(t), workspaceIds: workspaceIdsOf(t) } : null;
}

export function hasAnyToken(): boolean {
  return load().length > 0;
}
