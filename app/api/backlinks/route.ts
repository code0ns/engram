import { getBacklinks, getOutlinks } from "@/lib/vault/store";
import { resolveDashboardWorkspace } from "@/lib/workspace-resolve";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ws = await resolveDashboardWorkspace(req);
  if (!ws) return Response.json({ error: "no workspace access" }, { status: 403 });
  const p = new URL(req.url).searchParams.get("path");
  if (!p) return Response.json({ error: "path required" }, { status: 400 });
  return Response.json({ backlinks: getBacklinks(ws.dir, p), outlinks: getOutlinks(ws.dir, p) });
}
