import { getFolderColorOverrides, setFolderColor } from "@/lib/vault/colors";
import { resolveDashboardWorkspace } from "@/lib/workspace-resolve";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ws = await resolveDashboardWorkspace(req);
  if (!ws) return Response.json({ error: "no workspace access" }, { status: 403 });
  return Response.json({ colors: await getFolderColorOverrides(ws.dir) });
}

export async function PATCH(req: Request) {
  const ws = await resolveDashboardWorkspace(req);
  if (!ws) return Response.json({ error: "no workspace access" }, { status: 403 });
  const { folder, color } = await req.json().catch(() => ({}));
  if (!folder || typeof folder !== "string") return Response.json({ error: "folder required" }, { status: 400 });
  if (!color || typeof color !== "string") return Response.json({ error: "color required" }, { status: 400 });
  try {
    await setFolderColor(ws.dir, folder, color);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "invalid color" }, { status: 400 });
  }
  return Response.json({ ok: true });
}
