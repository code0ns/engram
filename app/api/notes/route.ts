import { listNotes } from "@/lib/vault/store";
import { writeNote } from "@/lib/vault/write";
import { resolveDashboardWorkspace } from "@/lib/workspace-resolve";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ws = await resolveDashboardWorkspace(req);
  if (!ws) return Response.json({ error: "no workspace access" }, { status: 403 });
  return Response.json({ notes: listNotes(ws.dir) });
}

export async function POST(req: Request) {
  const ws = await resolveDashboardWorkspace(req);
  if (!ws) return Response.json({ error: "no workspace access" }, { status: 403 });
  const { path, body, frontmatter } = await req.json().catch(() => ({}));
  if (!path || typeof path !== "string") return Response.json({ error: "path required" }, { status: 400 });
  const saved = await writeNote(ws.dir, path, typeof body === "string" ? body : "", frontmatter);
  return Response.json({ ok: true, path: saved });
}
