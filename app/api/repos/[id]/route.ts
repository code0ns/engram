import { removeRepo, renameRepo, vaultDirFor } from "@/lib/repos";
import { forgetWorkspace } from "@/lib/vault/store";
import { getSession, isAllowed } from "@/lib/auth";
import { dashboardAuthEnforced, grantedWorkspacesFor } from "@/lib/workspace-resolve";
import { pruneWorkspace } from "@/lib/access";

export const dynamic = "force-dynamic";

/** True in local/no-auth mode; otherwise only when this session is granted `id`. */
async function canAccess(req: Request, id: string): Promise<boolean> {
  if (!dashboardAuthEnforced()) return true;
  const session = await getSession(req);
  if (!session || !isAllowed(session.email)) return false;
  return grantedWorkspacesFor(session.email).some((r) => r.id === id);
}

/** Rename a workspace (display name). Body: { name }. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await canAccess(req, id))) return Response.json({ error: "not granted" }, { status: 403 });
  const { name } = await req.json().catch(() => ({}));
  if (!name || !String(name).trim()) return Response.json({ error: "name required" }, { status: 400 });
  const repo = renameRepo(id, String(name));
  if (!repo) return Response.json({ error: "workspace not found" }, { status: 404 });
  return Response.json({ ok: true, repo });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await canAccess(req, id))) return Response.json({ error: "not granted" }, { status: 403 });
  forgetWorkspace(vaultDirFor(id));
  removeRepo(id);
  pruneWorkspace(id);
  return Response.json({ ok: true });
}
