import { pullWorkspace, syncStatus, syncNow } from "@/lib/git";
import { resolveDashboardWorkspace } from "@/lib/workspace-resolve";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ws = await resolveDashboardWorkspace(req);
  if (!ws) return Response.json({ error: "no workspace access" }, { status: 403 });
  return Response.json(await syncStatus(ws.dir));
}

/**
 * Manual sync — pull or full sync (commit + push) this workspace.
 *
 * By default, does a pull only. Pass `?push=true` or `{"push": true}` to trigger a full
 * sync that commits any dirty changes and pushes to the remote. Use this to recover from
 * the "notes in UI but GitHub empty" scenario.
 */
export async function POST(req: Request) {
  const ws = await resolveDashboardWorkspace(req);
  if (!ws) return Response.json({ error: "no workspace access" }, { status: 403 });

  // Check for push request via query param or body
  const url = new URL(req.url);
  const pushParam = url.searchParams.get("push") === "true";
  let pushBody = false;
  try {
    const body = await req.json().catch(() => ({}));
    pushBody = body?.push === true;
  } catch {
    // No body or invalid JSON - that's fine
  }

  if (pushParam || pushBody) {
    // Full sync: commit any dirty files and push to remote
    const result = await syncNow(ws.dir, "manual sync via API");
    if (result === null) {
      return Response.json({ ok: false, error: "sync skipped - another operation in progress" });
    }
    return Response.json({ ok: true, ...result });
  }

  // Default: pull only
  return Response.json(await pullWorkspace(ws.dir));
}
