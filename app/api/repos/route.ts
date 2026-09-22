import { addRepo, getActive, listRepos } from "@/lib/repos";
import { githubToken } from "@/lib/github";
import { rebuildIndex } from "@/lib/vault/store";
import { getSession, isAllowed } from "@/lib/auth";
import { addGrant } from "@/lib/access";
import { dashboardAuthEnforced, grantedWorkspacesFor, resolveDashboardWorkspace } from "@/lib/workspace-resolve";
import { vaultDirFor } from "@/lib/repos";

export const dynamic = "force-dynamic";

/**
 * The workspace list this caller may see — every workspace in local/no-auth mode (matches
 * pre-permissions behavior), or only their granted ones once auth is enforced. Ungranted
 * workspaces are hidden entirely, not shown read-only: a client's vault name is itself
 * sensitive when a different client's colleague is looking.
 */
export async function GET(req: Request) {
  if (!dashboardAuthEnforced()) {
    return Response.json({ repos: listRepos(), active: getActive(), currentWorkspaceId: getActive()?.id ?? null });
  }
  const session = await getSession(req);
  if (!session || !isAllowed(session.email)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const repos = grantedWorkspacesFor(session.email);
  const ws = await resolveDashboardWorkspace(req);
  return Response.json({ repos, active: getActive(), currentWorkspaceId: ws?.workspaceId ?? null });
}

export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  const url = b.cloneUrl || b.url || (b.fullName ? `https://github.com/${b.fullName}.git` : "");
  if (!url) return Response.json({ error: "repo url or fullName required" }, { status: 400 });
  // "owner/repo" derived from the URL, for a nice default name.
  const derived = String(url)
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/^git@[^:]+:/, "")
    .replace(/\.git$/, "");
  try {
    const repo = await addRepo({
      name: b.name || b.fullName || derived || url,
      fullName: b.fullName || (derived.includes("/") ? derived : undefined),
      url,
      // Explicit pasted token (PAT path) wins; else the OAuth-connected token.
      token: b.token || githubToken() || undefined,
      branch: b.branch,
      setActive: b.setActive,
    });
    rebuildIndex(vaultDirFor(repo.id));
    // The creator should see what they just made, even if they already have other grants —
    // otherwise an owner who's trimmed their own grants can't reach a workspace they just added.
    if (dashboardAuthEnforced()) {
      const session = await getSession(req);
      if (session) addGrant(session.email, repo.id);
    }
    return Response.json({ ok: true, repo });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
