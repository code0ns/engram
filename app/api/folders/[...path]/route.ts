import { deleteFolderRecursive, renameFolder } from "@/lib/vault/write";

export const dynamic = "force-dynamic";

/** Rename/move a folder (every note under it). Body: { to: "new/folder/path" }. */
export async function PATCH(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const rel = path.map(decodeURIComponent).join("/");
  const { to } = await req.json().catch(() => ({}));
  if (!to || typeof to !== "string") return Response.json({ error: "to (string) required" }, { status: 400 });
  try {
    const result = await renameFolder(rel, to);
    return Response.json({ ok: true, ...result });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "rename failed" }, { status: 400 });
  }
}

/** Delete a folder and every note under it. Irreversible — dashboard confirms first. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const rel = path.map(decodeURIComponent).join("/");
  try {
    const result = await deleteFolderRecursive(rel);
    return Response.json({ ok: true, ...result });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "delete failed" }, { status: 400 });
  }
}
