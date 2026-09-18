import { listApprovals, pcRoute, type ApprovalStatus } from "@/lib/paperclip/client";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const url = new URL(req.url);
  const companyId = url.searchParams.get("companyId");
  const status = url.searchParams.get("status") as ApprovalStatus | null;
  if (!companyId) return Response.json({ error: "companyId required" }, { status: 400 });
  return pcRoute(async () => ({ approvals: await listApprovals(companyId, status ?? undefined) }));
}
