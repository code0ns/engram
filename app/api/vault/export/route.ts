import { resolveDashboardWorkspace } from "@/lib/workspace-resolve";
import { createVaultZip } from "@/lib/vault/export";

export const dynamic = "force-dynamic";

/**
 * Download the current workspace as a zip file for backup.
 *
 * Respects dashboard auth and workspace grants - only exports vaults the caller can access.
 * Excludes .git by default (smaller download, still a full note backup).
 * Pass ?includeGit=1 to include .git (for full repo backup with history).
 *
 * USE THIS BEFORE fixing credentials via updateRepoToken, in case anything goes wrong.
 * NEVER delete+add a workspace to "fix" auth - download a backup first!
 */
export async function GET(req: Request) {
  const ws = await resolveDashboardWorkspace(req);
  if (!ws) {
    return new Response(JSON.stringify({ error: "no workspace access" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const includeGit = url.searchParams.get("includeGit") === "1";

  try {
    const { stream, filename } = await createVaultZip(ws.dir, ws.name, { includeGit });

    return new Response(stream, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[vault/export] failed:", e);
    return new Response(JSON.stringify({ error: `export failed: ${msg}` }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
