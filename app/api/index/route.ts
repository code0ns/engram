import { readVaultFile } from "@/lib/vault/store";
import { resolveDashboardWorkspace } from "@/lib/workspace-resolve";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ws = await resolveDashboardWorkspace(req);
  if (!ws) return Response.json({ error: "no workspace access" }, { status: 403 });
  const content = readVaultFile(ws.dir, "INDEX.md");
  if (content == null) return Response.json({ error: "no INDEX.md" }, { status: 404 });
  return new Response(content, { headers: { "content-type": "text/markdown; charset=utf-8" } });
}
