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

  // Visible: has at least one workspace the caller is granted, or unscoped-legacy tokens
  // (which resolve to the global default) — but only if the caller is granted THAT one.
  const granted = new Set(grantedWorkspacesFor(session.email).map((r) => r.id));
  const defaultId = getActive()?.id;
  const visible = all.filter((t) => {
    if (t.workspaceIds.length === 0) return defaultId && granted.has(defaultId);
    return t.workspaceIds.some((id) => granted.has(id));
  });
  return Response.json({ tokens: visible });
}

export async function POST(req: Request) {
  const { name, scope, workspaceId, workspaceIds } = await req.json().catch(() => ({}));
  const enforced = dashboardAuthEnforced();

  // Support both legacy single workspaceId and new workspaceIds array
  let ids: string[] = [];
  if (Array.isArray(workspaceIds)) {
    ids = workspaceIds.filter((id): id is string => typeof id === "string");
  } else if (typeof workspaceId === "string") {
    ids = [workspaceId];
  }

  if (enforced) {
    const session = await getSession(req);
    if (!session || !isAllowed(session.email)) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (ids.length === 0) {
      return Response.json({ error: "at least one workspaceId required" }, { status: 400 });
    }
    const grantedIds = new Set(grantedWorkspacesFor(session.email).map((r) => r.id));
    const notGranted = ids.filter((id) => !grantedIds.has(id));
    if (notGranted.length > 0) {
      return Response.json({ error: `not granted to workspace(s): ${notGranted.join(", ")}` }, { status: 403 });
    }
  }

  // Returns the plaintext token ONCE — only its hash is stored.
  // Scope decides whether the holder may mutate the vault; anything but "read" means full access.
  return Response.json(
    createToken(
      typeof name === "string" ? name : "token",
      scope === "read" ? "read" : "write",
      ids.length > 0 ? ids : undefined,
    ),
  );
}
