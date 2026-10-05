import { removeRepo, renameRepo, updateRepoToken, vaultDirFor } from "@/lib/repos";
import { forgetWorkspace } from "@/lib/vault/store";
import { canAccessWorkspace, requireAdmin } from "@/lib/workspace-resolve";
import { pruneWorkspace } from "@/lib/access";
import { pruneTreg } from "@/lib/treg-config";

export const dynamic = "force-dynamic";

/** Everything here changes or destroys a workspace: admins only, and only ones granted on it.
 *  Returns a Response to send back on failure, or null to proceed. */
async function guard(req: Request, id: string): Promise<Response | null> {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  if (!(await canAccessWorkspace(req, id))) return Response.json({ error: "not granted" }, { status: 403 });
  return null;
}

/** Rename a workspace (display name). Body: { name }. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = await guard(req, id);
  if (denied) return denied;
  const { name } = await req.json().catch(() => ({}));
  if (!name || !String(name).trim()) return Response.json({ error: "name required" }, { status: 400 });
  const repo = renameRepo(id, String(name));
  if (!repo) return Response.json({ error: "workspace not found" }, { status: 404 });
  return Response.json({ ok: true, repo });
}

/**
 * SAFE token update: refresh git credentials WITHOUT deleting the clone.
 * Body: { token: "ghp_..." }
 *
 * Use this to fix 403/auth errors without losing unpushed notes.
 * NEVER use delete+add to "reconnect" — that wipes the clone!
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = await guard(req, id);
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  const token = body?.token;
  if (!token || typeof token !== "string" || !token.trim()) {
    return Response.json({ error: "token required" }, { status: 400 });
  }

  const result = await updateRepoToken(id, token.trim());
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 400 });
  }

  return Response.json({ ok: true, repo: result.repo });
}

/**
 * DANGER: DELETE removes the workspace AND deletes the entire vault clone!
 * Any unpushed notes will be LOST.
 *
 * To fix auth errors, use PUT with a new token instead — it preserves the clone.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = await guard(req, id);
  if (denied) return denied;
  forgetWorkspace(vaultDirFor(id));
  removeRepo(id);
  pruneWorkspace(id);
  pruneTreg(id);
  return Response.json({ ok: true });
}
