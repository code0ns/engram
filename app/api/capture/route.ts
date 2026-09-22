import { captureNote } from "@/lib/harness";
import { resolveDashboardWorkspace } from "@/lib/workspace-resolve";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ws = await resolveDashboardWorkspace(req);
  if (!ws) return Response.json({ error: "no workspace access" }, { status: 403 });
  const { text } = await req.json().catch(() => ({}));
  if (!text || typeof text !== "string") return Response.json({ error: "text required" }, { status: 400 });
  try {
    return Response.json(await captureNote(text, ws.dir));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
