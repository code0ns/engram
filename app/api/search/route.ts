import { searchNotes } from "@/lib/vault/store";
import { resolveDashboardWorkspace } from "@/lib/workspace-resolve";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ws = await resolveDashboardWorkspace(req);
  if (!ws) return Response.json({ error: "no workspace access" }, { status: 403 });
  const params = new URL(req.url).searchParams;
  const q = params.get("q") ?? "";
  // Humans browsing the dashboard should find archived AND retired notes (they still rank far
  // below live ones). Agents (MCP) get both excluded by default. Insulation point: map the new
  // { hits, excluded } shape back to a `results` array so the dashboard's contract is unchanged.
  const r = searchNotes(ws.dir, q, {
    includeArchive: params.get("archive") !== "false",
    includeInvalid: params.get("invalid") !== "false",
  });
  return Response.json({ results: r.hits, excluded: r.excluded });
}
