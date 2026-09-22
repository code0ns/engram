import { getSession } from "@/lib/auth";
import { resolveDashboardWorkspace } from "@/lib/workspace-resolve";
import { withActor } from "@/lib/actor";
import { getBacklinks, getNote, getOutlinks } from "@/lib/vault/store";
import { checkFrontmatter } from "@/lib/vault/validate";
import { deleteNote, moveNote, writeNoteRaw } from "@/lib/vault/write";

export const dynamic = "force-dynamic";

/** Attribute dashboard writes to the signed-in human, so the git log is not anonymous. */
async function actorFor(req: Request): Promise<string> {
  const session = await getSession(req);
  return session?.email ? `dashboard (${session.email})` : "dashboard";
}

export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const ws = await resolveDashboardWorkspace(req);
  if (!ws) return Response.json({ error: "no workspace access" }, { status: 403 });
  const { path } = await params;
  const rel = path.map(decodeURIComponent).join("/");
  const note = getNote(ws.dir, rel);
  if (!note) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ note, backlinks: getBacklinks(ws.dir, rel), outlinks: getOutlinks(ws.dir, rel) });
}

export async function PUT(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const ws = await resolveDashboardWorkspace(req);
  if (!ws) return Response.json({ error: "no workspace access" }, { status: 403 });
  const { path } = await params;
  const rel = path.map(decodeURIComponent).join("/");
  const { content } = await req.json().catch(() => ({}));
  if (typeof content !== "string") return Response.json({ error: "content (string) required" }, { status: 400 });
  // Non-strict: a human may autosave half-typed frontmatter. Save it, but tell them it is broken —
  // otherwise the note silently loses its status and tags. (Agents are refused; see lib/mcp/tools.ts.)
  // allowShrink: a human in the editor can see what they are deleting. Agents cannot.
  const actor = await actorFor(req);
  const saved = await withActor(actor, () => writeNoteRaw(ws.dir, rel, content, { allowShrink: true }));
  const check = checkFrontmatter(content);
  return Response.json({
    ok: true,
    path: saved,
    ...(check.ok
      ? {}
      : {
          warning: `Frontmatter is not valid YAML (${check.error}) — this note's status, tags and title are being ignored. Usual cause: an unquoted ":" in a value.`,
        }),
  });
}

/** Rename/move a single note. Body: { to: "new/path.md" }. */
export async function PATCH(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const ws = await resolveDashboardWorkspace(req);
  if (!ws) return Response.json({ error: "no workspace access" }, { status: 403 });
  const { path } = await params;
  const rel = path.map(decodeURIComponent).join("/");
  const { to } = await req.json().catch(() => ({}));
  if (!to || typeof to !== "string") return Response.json({ error: "to (string) required" }, { status: 400 });
  const actor = await actorFor(req);
  try {
    const saved = await withActor(actor, () => moveNote(ws.dir, rel, to));
    return Response.json({ ok: true, path: saved });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "rename failed" }, { status: 400 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const ws = await resolveDashboardWorkspace(req);
  if (!ws) return Response.json({ error: "no workspace access" }, { status: 403 });
  const { path } = await params;
  const rel = path.map(decodeURIComponent).join("/");
  const actor = await actorFor(req);
  await withActor(actor, () => deleteNote(ws.dir, rel));
  return Response.json({ ok: true });
}
