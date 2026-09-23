import { listTokens, revokeToken, updateToken } from "@/lib/tokens";
import { getSession, isAllowed } from "@/lib/auth";
import { getActive } from "@/lib/repos";
import { dashboardAuthEnforced, grantedWorkspacesFor } from "@/lib/workspace-resolve";

export const dynamic = "force-dynamic";

/** Update a token's workspace assignments. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { workspaceId, workspaceIds } = await req.json().catch(() => ({}));

  // Support both legacy single workspaceId and new workspaceIds array
  let ids: string[] = [];
  if (Array.isArray(workspaceIds)) {
    ids = workspaceIds.filter((i): i is string => typeof i === "string");
  } else if (typeof workspaceId === "string") {
    ids = [workspaceId];
  }

  if (dashboardAuthEnforced()) {
    const session = await getSession(req);
    if (!session || !isAllowed(session.email)) return Response.json({ error: "unauthorized" }, { status: 401 });

    const token = listTokens().find((t) => t.id === id);
    if (!token) return Response.json({ error: "not found" }, { status: 404 });

    const granted = new Set(grantedWorkspacesFor(session.email).map((r) => r.id));
    const defaultId = getActive()?.id;
    
    // Check caller has access to at least one of the token's current workspaces
    const currentIds = token.workspaceIds.length > 0 ? token.workspaceIds : (defaultId ? [defaultId] : []);
    if (!currentIds.some((wsId) => granted.has(wsId))) {
      return Response.json({ error: "not granted to current workspace" }, { status: 403 });
    }

    if (ids.length === 0) {
      return Response.json({ error: "at least one workspaceId required" }, { status: 400 });
    }
    const notGranted = ids.filter((wsId) => !granted.has(wsId));
    if (notGranted.length > 0) {
      return Response.json({ error: `not granted to workspace(s): ${notGranted.join(", ")}` }, { status: 403 });
    }
  }

  const updated = updateToken(id, ids);
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
      const scopedIds = token.workspaceIds.length > 0 ? token.workspaceIds : (defaultId ? [defaultId] : []);
      if (!scopedIds.some((wsId) => granted.has(wsId))) {
        return Response.json({ error: "not granted" }, { status: 403 });
      }
    }
  }

  revokeToken(id);
  return Response.json({ ok: true });
}
