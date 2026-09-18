import { createCompany, listCompanies, pcRoute } from "@/lib/paperclip/client";

export const dynamic = "force-dynamic";

export function GET() {
  return pcRoute(async () => ({ companies: await listCompanies() }));
}

export async function POST(req: Request) {
  const { name, description } = await req.json().catch(() => ({}));
  if (!name || !String(name).trim()) return Response.json({ error: "name required" }, { status: 400 });
  return pcRoute(() => createCompany(String(name).trim(), description ? String(description) : undefined));
}
