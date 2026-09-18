import { getOrg, pcRoute } from "@/lib/paperclip/client";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) return Response.json({ error: "companyId required" }, { status: 400 });
  return pcRoute(async () => ({ org: await getOrg(companyId) }));
}
