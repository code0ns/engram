import { listTokens, revokeToken, updateToken } from "@/lib/tokens";
import { getSession, isAllowed } from "@/lib/auth";
import { getActive } from "@/lib/repos";
import { dashboardAuthEnforced, grantedWorkspacesFor } from "@/lib/workspace-resolve";

export const dynamic = "force-dynamic";

/** Update a token's workspace assignment. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { workspaceId } = await req.json().catch(() => ({}));

  if (dashboardAuthEnforced()) {
    const session = await getSession(req);
    if (!session || !isAllowed(session.email)) return Response.json({ error: "unauthorized" }, { status: 401 });

    const token = listTokens().find((t) => t.id === id);
    if (!token) return Response.json({ error: "not found" }, { status: 404 });

    const granted = new Set(grantedWorkspacesFor(session.email).map((r) => r.id));
    const defaultId = getActive()?.id;
    const currentScope = token.workspaceId ?? defaultId;
    if (!currentScope || !granted.has(currentScope)) {
      return Response.json({ error: "not granted to current workspace" }, { status: 403 });
    }

    if (!workspaceId || typeof workspaceId !== "string") {
      return Response.json({ error: "workspaceId required" }, { status: 400 });
    }
    if (!granted.has(workspaceId)) {
      return Response.json({ error: "not granted to target workspace" }, { status: 403 });
    }
  }

  const updated = updateToken(id, workspaceId);
  if (!updated) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ ok: true, token: updated });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (dashboardAuthEnforced()) {
    const session = await getSession(req);
    if (!session || !isAllowed(session.email)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const token = listTokens().find((t) => t.id === id);
    if (token) {
      const granted = new Set(grantedWorkspacesFor(session.email).map((r) => r.id));
      const defaultId = getActive()?.id;
      const scopedTo = token.workspaceId ?? defaultId;
      if (!scopedTo || !granted.has(scopedTo)) return Response.json({ error: "not granted" }, { status: 403 });
    }
  }

  revokeToken(id);
  return Response.json({ ok: true });
}
