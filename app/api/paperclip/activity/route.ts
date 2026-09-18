import { listActivity, pcRoute } from "@/lib/paperclip/client";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const url = new URL(req.url);
  const companyId = url.searchParams.get("companyId");
  const agentId = url.searchParams.get("agentId") ?? undefined;
  if (!companyId) return Response.json({ error: "companyId required" }, { status: 400 });
  return pcRoute(async () => ({ activity: await listActivity(companyId, { agentId }) }));
}
