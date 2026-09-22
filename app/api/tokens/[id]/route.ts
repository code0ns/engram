import { listTokens, revokeToken } from "@/lib/tokens";
import { getSession, isAllowed } from "@/lib/auth";
import { getActive } from "@/lib/repos";
import { dashboardAuthEnforced, grantedWorkspacesFor } from "@/lib/workspace-resolve";

export const dynamic = "force-dynamic";

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
