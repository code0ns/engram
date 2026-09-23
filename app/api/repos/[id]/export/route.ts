import { vaultDirFor, listRepos } from "@/lib/repos";
import { createVaultZip } from "@/lib/vault/export";
import { getSession, isAllowed } from "@/lib/auth";
import { dashboardAuthEnforced, grantedWorkspacesFor } from "@/lib/workspace-resolve";

export const dynamic = "force-dynamic";

/** True in local/no-auth mode; otherwise only when this session is granted `id`. */
async function canAccess(req: Request, id: string): Promise<boolean> {
  if (!dashboardAuthEnforced()) return true;
  const session = await getSession(req);
  if (!session || !isAllowed(session.email)) return false;
  return grantedWorkspacesFor(session.email).some((r) => r.id === id);
}

/**
 * Download a specific workspace as a zip file for backup.
 *
 * Respects dashboard auth and workspace grants - only exports vaults the caller can access.
 * Excludes .git by default (smaller download, still a full note backup).
 * Pass ?includeGit=1 to include .git (for full repo backup with history).
 *
 * USE THIS BEFORE fixing credentials via updateRepoToken, in case anything goes wrong.
 * NEVER delete+add a workspace to "fix" auth - download a backup first!
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!(await canAccess(req, id))) {
    return new Response(JSON.stringify({ error: "not granted" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  // Find the workspace
  const repo = listRepos().find((r) => r.id === id);
  if (!repo) {
    return new Response(JSON.stringify({ error: "workspace not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const includeGit = url.searchParams.get("includeGit") === "1";

  try {
    const dir = vaultDirFor(id);
    const { stream, filename } = await createVaultZip(dir, repo.name, { includeGit });

    return new Response(stream, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[repos/export] failed:", e);
    return new Response(JSON.stringify({ error: `export failed: ${msg}` }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
