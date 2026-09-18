import { createIssue, listIssues, pcRoute } from "@/lib/paperclip/client";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const url = new URL(req.url);
  const companyId = url.searchParams.get("companyId");
  const assigneeAgentId = url.searchParams.get("assigneeAgentId") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;
  if (!companyId) return Response.json({ error: "companyId required" }, { status: 400 });
  return pcRoute(async () => ({ issues: await listIssues(companyId, { assigneeAgentId, status }) }));
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { companyId, title, description, assigneeAgentId } = body as {
    companyId?: string;
    title?: string;
    description?: string;
    assigneeAgentId?: string;
  };
  if (!companyId) return Response.json({ error: "companyId required" }, { status: 400 });
  if (!title || !title.trim()) return Response.json({ error: "title required" }, { status: 400 });
  return pcRoute(() => createIssue(companyId, { title: title.trim(), description, assigneeAgentId }));
}
