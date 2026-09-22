import { createToken, listTokens } from "@/lib/tokens";
import { getSession, isAllowed } from "@/lib/auth";
import { getActive } from "@/lib/repos";
import { dashboardAuthEnforced, grantedWorkspacesFor } from "@/lib/workspace-resolve";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const all = listTokens();
  if (!dashboardAuthEnforced()) return Response.json({ tokens: all });

  const session = await getSession(req);
  if (!session || !isAllowed(session.email)) return Response.json({ error: "unauthorized" }, { status: 401 });

  // Visible: pinned to one of the caller's granted workspaces, or unscoped-legacy tokens
  // (which resolve to the global default) — but only if the caller is granted THAT one.
  const granted = new Set(grantedWorkspacesFor(session.email).map((r) => r.id));
  const defaultId = getActive()?.id;
  const visible = all.filter((t) => (t.workspaceId ? granted.has(t.workspaceId) : defaultId && granted.has(defaultId)));
  return Response.json({ tokens: visible });
}

export async function POST(req: Request) {
  const { name, scope, workspaceId } = await req.json().catch(() => ({}));
  const enforced = dashboardAuthEnforced();

  if (enforced) {
    const session = await getSession(req);
    if (!session || !isAllowed(session.email)) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!workspaceId || typeof workspaceId !== "string") {
      return Response.json({ error: "workspaceId required" }, { status: 400 });
    }
    if (!grantedWorkspacesFor(session.email).some((r) => r.id === workspaceId)) {
      return Response.json({ error: "not granted" }, { status: 403 });
    }
  }

  // Returns the plaintext token ONCE — only its hash is stored.
  // Scope decides whether the holder may mutate the vault; anything but "read" means full access.
  return Response.json(
    createToken(
      typeof name === "string" ? name : "token",
      scope === "read" ? "read" : "write",
      typeof workspaceId === "string" ? workspaceId : undefined,
    ),
  );
}
