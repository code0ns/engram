import { createFolder } from "@/lib/vault/write";
import { resolveDashboardWorkspace } from "@/lib/workspace-resolve";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ws = await resolveDashboardWorkspace(req);
  if (!ws) return Response.json({ error: "no workspace access" }, { status: 403 });
  const { path } = await req.json().catch(() => ({}));
  if (!path || typeof path !== "string") return Response.json({ error: "path required" }, { status: 400 });
  const created = await createFolder(ws.dir, path);
  return Response.json({ ok: true, path: created });
}
