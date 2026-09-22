import { pullWorkspace, syncStatus } from "@/lib/git";
import { resolveDashboardWorkspace } from "@/lib/workspace-resolve";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ws = await resolveDashboardWorkspace(req);
  if (!ws) return Response.json({ error: "no workspace access" }, { status: 403 });
  return Response.json(await syncStatus(ws.dir));
}

/** Manual refresh — pull this workspace's remote now (index rebuilds on change). */
export async function POST(req: Request) {
  const ws = await resolveDashboardWorkspace(req);
  if (!ws) return Response.json({ error: "no workspace access" }, { status: 403 });
  return Response.json(await pullWorkspace(ws.dir));
}
