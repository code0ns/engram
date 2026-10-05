import { ALLOWED_EMAILS } from "@/lib/config";
import { getSession, isAllowed } from "@/lib/auth";
import { allGrants, isAdmin, removeGrants, setAdmin, setGrantsForEmail } from "@/lib/access";
import { listRepos } from "@/lib/repos";
import { dashboardAuthEnforced, grantedWorkspacesFor, requireAdmin } from "@/lib/workspace-resolve";

export const dynamic = "force-dynamic";

/**
 * Who can see which workspace. Reading is open to any signed-in allowed user, but a non-admin
 * only gets their own row and their own workspaces (a colleague at one client must not learn the
 * names of another client's vaults or who else is on this instance). Every change is admin-only
 * (lib/workspace-resolve.ts requireAdmin).
 */
export async function GET(req: Request) {
  if (!dashboardAuthEnforced()) {
    return Response.json({
      authEnforced: false,
      me: { email: "local", isAdmin: true },
      grants: [],
      repos: listRepos(),
      allowedEmails: [],
    });
  }
  const session = await getSession(req);
  if (!session || !isAllowed(session.email)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const me = { email: session.email.toLowerCase(), isAdmin: isAdmin(session.email) };
  if (!me.isAdmin) {
    return Response.json({
      authEnforced: true,
      me,
      grants: allGrants().filter((g) => g.email === me.email),
      repos: grantedWorkspacesFor(session.email),
      allowedEmails: [],
    });
  }
  return Response.json({ authEnforced: true, me, grants: allGrants(), repos: listRepos(), allowedEmails: ALLOWED_EMAILS });
}

/** Body: { email, workspaceIds?: string[], isAdmin?: boolean } — at least one of the two. */
export async function POST(req: Request) {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  const { email, workspaceIds, isAdmin: makeAdmin } = await req.json().catch(() => ({}));
  if (!email || typeof email !== "string") return Response.json({ error: "email required" }, { status: 400 });
  if (!isAllowed(email)) {
    return Response.json({ error: `${email} is not on the ALLOWED_EMAILS allowlist — they still couldn't log in.` }, { status: 400 });
  }
  const hasIds = workspaceIds !== undefined;
  const hasAdmin = makeAdmin !== undefined;
  if (!hasIds && !hasAdmin) return Response.json({ error: "workspaceIds or isAdmin required" }, { status: 400 });
  if (hasIds && (!Array.isArray(workspaceIds) || !workspaceIds.every((w) => typeof w === "string"))) {
    return Response.json({ error: "workspaceIds (string[]) required" }, { status: 400 });
  }
  if (hasAdmin && typeof makeAdmin !== "boolean") {
    return Response.json({ error: "isAdmin must be a boolean" }, { status: 400 });
  }
  try {
    if (hasIds) setGrantsForEmail(email, workspaceIds);
    if (hasAdmin) setAdmin(email, makeAdmin);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
  return Response.json({ ok: true });
}

export async function DELETE(req: Request) {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  const email = new URL(req.url).searchParams.get("email");
  if (!email) return Response.json({ error: "email required" }, { status: 400 });
  try {
    removeGrants(email);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
  return Response.json({ ok: true });
}
