import { ALLOWED_EMAILS } from "@/lib/config";
import { getSession, isAllowed } from "@/lib/auth";
import { allGrants, setGrantsForEmail, removeGrants } from "@/lib/access";
import { listRepos } from "@/lib/repos";
import { dashboardAuthEnforced } from "@/lib/workspace-resolve";

export const dynamic = "force-dynamic";

/**
 * No admin/member role split exists anywhere in this codebase (only the coarse ALLOWED_EMAILS
 * gate) — reachable by any signed-in allowed user, same trust level as /workspaces and
 * /settings today.
 */
export async function GET(req: Request) {
  if (!dashboardAuthEnforced()) {
    return Response.json({ authEnforced: false, grants: [], repos: listRepos(), allowedEmails: [] });
  }
  const session = await getSession(req);
  if (!session || !isAllowed(session.email)) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json({ authEnforced: true, grants: allGrants(), repos: listRepos(), allowedEmails: ALLOWED_EMAILS });
}

export async function POST(req: Request) {
  const session = await getSession(req);
  if (!session || !isAllowed(session.email)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { email, workspaceIds } = await req.json().catch(() => ({}));
  if (!email || typeof email !== "string") return Response.json({ error: "email required" }, { status: 400 });
  if (!isAllowed(email)) {
    return Response.json({ error: `${email} is not on the ALLOWED_EMAILS allowlist — they still couldn't log in.` }, { status: 400 });
  }
  if (!Array.isArray(workspaceIds) || !workspaceIds.every((w) => typeof w === "string")) {
    return Response.json({ error: "workspaceIds (string[]) required" }, { status: 400 });
  }
  setGrantsForEmail(email, workspaceIds);
  return Response.json({ ok: true });
}

export async function DELETE(req: Request) {
  const session = await getSession(req);
  if (!session || !isAllowed(session.email)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const email = new URL(req.url).searchParams.get("email");
  if (!email) return Response.json({ error: "email required" }, { status: 400 });
  removeGrants(email);
  return Response.json({ ok: true });
}
