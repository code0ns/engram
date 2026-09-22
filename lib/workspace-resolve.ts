import { AUTH_DISABLED, AUTH_SECRET, VAULT_DIR } from "@/lib/config";
import { getSession, isAllowed } from "@/lib/auth";
import { grantsForEmail } from "@/lib/access";
import { listRepos, getActive, vaultDirFor, type Repo } from "@/lib/repos";

/**
 * The one place caller identity resolves to a vault directory. Every vault-reading
 * function downstream (lib/vault/store.ts, lib/git.ts, lib/vault/write.ts, MCP tools,
 * the Curator) takes an explicit `dir` — this module is the only thing that decides
 * which `dir` a given request is allowed to use.
 */

export interface ResolvedWorkspace {
  /** null when resolved to the legacy fallback (no workspace record — sample/local vault). */
  workspaceId: string | null;
  dir: string;
  name: string;
}

/** The legacy global "active" workspace, or the bundled sample vault if none is active.
 *  This is the fallback every unscoped identity (local mode, shared MCP_TOKEN, a
 *  pre-migration token, or auth turned off entirely) resolves to. */
function defaultWorkspace(): ResolvedWorkspace {
  const active = getActive();
  return active
    ? { workspaceId: active.id, dir: vaultDirFor(active.id), name: active.name }
    : { workspaceId: null, dir: VAULT_DIR, name: "Sample vault" };
}

/** Exported for routes (e.g. repos) that need to decide whether to filter/scope by grants
 *  at all, not just resolve a single current workspace. */
export function dashboardAuthEnforced(): boolean {
  return !AUTH_DISABLED && AUTH_SECRET !== "";
}

function repoToResolved(r: Repo): ResolvedWorkspace {
  return { workspaceId: r.id, dir: vaultDirFor(r.id), name: r.name };
}

/** Every workspace this email may currently switch to. */
export function grantedWorkspacesFor(email: string): Repo[] {
  const granted = new Set(grantsForEmail(email));
  return listRepos().filter((r) => granted.has(r.id));
}

/**
 * Dashboard requests. Local/no-auth mode (AUTH_DISABLED or empty AUTH_SECRET) bypasses
 * grants entirely and returns the legacy default — this is what keeps a single-user
 * self-hosted deploy behaving exactly as it did before this feature existed.
 *
 * Otherwise: decode the session cookie, then look up LIVE grants — the JWT's own
 * `workspaceId` claim is a hint only and is never trusted as authorization by itself,
 * so a grant revoked mid-session takes effect on this caller's very next request rather
 * than waiting out the 30-day cookie.
 *
 * Returns null when the caller has no session, or is allowed to log in but currently has
 * no usable workspace (all grants revoked) — callers must treat null as a 401/403.
 */
export async function resolveDashboardWorkspace(req: Request): Promise<ResolvedWorkspace | null> {
  if (!dashboardAuthEnforced()) return defaultWorkspace();

  const session = await getSession(req);
  if (!session || !isAllowed(session.email)) return null;

  const granted = grantedWorkspacesFor(session.email);
  if (granted.length === 0) return null;

  const preferred = session.workspaceId && granted.find((r) => r.id === session.workspaceId);
  if (preferred) return repoToResolved(preferred);

  const active = getActive();
  const activeGranted = active && granted.find((r) => r.id === active.id);
  return repoToResolved(activeGranted || granted[0]);
}

/** Discriminates how an MCP/token caller's identity was established (app/api/mcp/route.ts). */
export type TokenCaller =
  | { kind: "local" }
  | { kind: "shared" }
  | { kind: "named"; workspaceId?: string }
  | { kind: "oauth"; email: string };

/**
 * MCP/token callers. "local" (no auth configured at all), "shared" (the env MCP_TOKEN),
 * and a "named" token minted before workspace pinning existed (workspaceId undefined)
 * all fall back to the legacy default workspace — these are credentials that predate or
 * were always meant as "the operator, full access."
 *
 * A "named" token WITH a workspaceId resolves only to that workspace, or null if it was
 * since deleted (never silently falls back — a deleted workspace must surface as an
 * error, not quietly hand the token a different vault).
 *
 * "oauth" carries a real identity (the Google-login email, via lib/oauth.ts's `sub`) that
 * went through the same ALLOWED_EMAILS gate as a dashboard login, so it gets the same
 * treatment: zero grants is zero access, never a fallback to default.
 */
export function resolveTokenWorkspace(caller: TokenCaller): ResolvedWorkspace | null {
  switch (caller.kind) {
    case "local":
    case "shared":
      return defaultWorkspace();
    case "named": {
      if (!caller.workspaceId) return defaultWorkspace();
      const repo = listRepos().find((r) => r.id === caller.workspaceId);
      return repo ? repoToResolved(repo) : null;
    }
    case "oauth": {
      if (!isAllowed(caller.email)) return null;
      const granted = grantedWorkspacesFor(caller.email);
      if (granted.length === 0) return null;
      const active = getActive();
      const activeGranted = active && granted.find((r) => r.id === active.id);
      return repoToResolved(activeGranted || granted[0]);
    }
  }
}
