import { getGraph } from "@/lib/vault/store";
import { resolveDashboardWorkspace } from "@/lib/workspace-resolve";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ws = await resolveDashboardWorkspace(req);
  if (!ws) return Response.json({ error: "no workspace access" }, { status: 403 });
  const folder = new URL(req.url).searchParams.get("folder") || undefined;
  return Response.json(getGraph(ws.dir, folder));
}
