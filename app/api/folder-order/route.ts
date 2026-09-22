import { getFolderOrder, setFolderOrder } from "@/lib/vault/folder-order";
import { resolveDashboardWorkspace } from "@/lib/workspace-resolve";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ws = await resolveDashboardWorkspace(req);
  if (!ws) return Response.json({ error: "no workspace access" }, { status: 403 });
  return Response.json({ order: await getFolderOrder(ws.dir) });
}

/**
 * Update folder order within a parent directory.
 * Body: { parentPath: string, folderNames: string[] }
 */
export async function PATCH(req: Request) {
  const ws = await resolveDashboardWorkspace(req);
  if (!ws) return Response.json({ error: "no workspace access" }, { status: 403 });
  const { parentPath, folderNames } = await req.json().catch(() => ({}));
  if (typeof parentPath !== "string") {
    return Response.json({ error: "parentPath (string) required" }, { status: 400 });
  }
  if (!Array.isArray(folderNames) || !folderNames.every((n) => typeof n === "string")) {
    return Response.json({ error: "folderNames (string array) required" }, { status: 400 });
  }
  try {
    await setFolderOrder(ws.dir, parentPath, folderNames);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "failed to set order" }, { status: 400 });
  }
  return Response.json({ ok: true });
}
