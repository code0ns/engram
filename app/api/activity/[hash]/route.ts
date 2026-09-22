import { commitChanges } from "@/lib/git";
import { resolveDashboardWorkspace } from "@/lib/workspace-resolve";

export const dynamic = "force-dynamic";

/** What a single vault commit changed: touched files (with status) + the raw patch. */
export async function GET(req: Request, { params }: { params: Promise<{ hash: string }> }) {
  const ws = await resolveDashboardWorkspace(req);
  if (!ws) return Response.json({ error: "no workspace access" }, { status: 403 });
  const { hash } = await params;
  const detail = await commitChanges(ws.dir, hash);
  if (!detail) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(detail);
}
