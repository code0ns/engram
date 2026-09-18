import { pcRoute, testAdapterEnvironment } from "@/lib/paperclip/client";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ type: string }> }) {
  const { type } = await params;
  const body = await req.json().catch(() => ({}));
  const { companyId, adapterConfig } = body as { companyId?: string; adapterConfig?: Record<string, unknown> };
  if (!companyId) return Response.json({ error: "companyId required" }, { status: 400 });
  return pcRoute(() => testAdapterEnvironment(companyId, type, adapterConfig ?? {}));
}
