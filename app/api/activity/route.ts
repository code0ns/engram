import { vaultActivity } from "@/lib/git";
import { resolveDashboardWorkspace } from "@/lib/workspace-resolve";

export const dynamic = "force-dynamic";

/**
 * Recent vault commits (agent + human activity). `?limit=` caps the count (default 50, max 200).
 * `?path=` scopes it to commits touching that vault-relative folder (the folder-browser view).
 */
export async function GET(req: Request) {
  const ws = await resolveDashboardWorkspace(req);
  if (!ws) return Response.json({ error: "no workspace access" }, { status: 403 });
  const { searchParams } = new URL(req.url);
  const limit = Math.min(Math.max(Number(searchParams.get("limit")) || 50, 1), 200);
  const path = searchParams.get("path") || undefined;
  return Response.json({ activity: await vaultActivity(ws.dir, limit, path) });
}
