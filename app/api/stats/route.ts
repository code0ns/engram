import { getGraph, listNotes } from "@/lib/vault/store";
import { resolveDashboardWorkspace } from "@/lib/workspace-resolve";

export const dynamic = "force-dynamic";

/** Light vault stats for the home: note / folder / link counts. */
export async function GET(req: Request) {
  const ws = await resolveDashboardWorkspace(req);
  if (!ws) return Response.json({ error: "no workspace access" }, { status: 403 });
  const notes = listNotes(ws.dir);
  const folders = new Set(notes.map((n) => n.folder).filter((f) => f && f !== "root"));
  return Response.json({ notes: notes.length, folders: folders.size, links: getGraph(ws.dir).edges.length });
}
