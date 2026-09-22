import { setActive } from "@/lib/repos";
import { rebuildIndex } from "@/lib/vault/store";
import { createSessionToken, getSession } from "@/lib/auth";
import { APP_URL, SESSION_COOKIE } from "@/lib/config";
import { dashboardAuthEnforced, grantedWorkspacesFor, resolveDashboardWorkspace } from "@/lib/workspace-resolve";

export const dynamic = "force-dynamic";

/**
 * Despite the path, this no longer sets one global "active" workspace for everyone — it
 * switches THIS session's current workspace (re-issuing the session cookie with a new
 * `workspaceId` claim), restricted to workspaces the caller is granted. Kept at this path
 * (rather than renamed) to avoid extra client-side churn; the behavior change is the point.
 *
 * In local/no-auth mode there is no session to scope to, so it falls back to the legacy
 * global `active` flag — unchanged single-user behavior.
 */
export async function POST(req: Request) {
  const { id } = await req.json().catch(() => ({}));
  if (!id) return Response.json({ error: "id required" }, { status: 400 });

  if (!dashboardAuthEnforced()) {
    setActive(id);
    const ws = await resolveDashboardWorkspace(req);
    if (ws) rebuildIndex(ws.dir);
    return Response.json({ ok: true });
  }

  const session = await getSession(req);
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!grantedWorkspacesFor(session.email).some((r) => r.id === id)) {
    return Response.json({ error: "not granted" }, { status: 403 });
  }

  const token = await createSessionToken({ email: session.email, name: session.name, workspaceId: id });
  const secure = APP_URL.startsWith("https");
  const headers = new Headers({ "content-type": "application/json" });
  headers.append("set-cookie", `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${secure ? "; Secure" : ""}`);
  return new Response(JSON.stringify({ ok: true }), { headers });
}
