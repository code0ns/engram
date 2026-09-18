import { getAgent, pcRoute, updateAgent } from "@/lib/paperclip/client";

export const dynamic = "force-dynamic";

export function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return pcRoute(async () => getAgent((await params).id));
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const patch = await req.json().catch(() => ({}));
  return pcRoute(() => updateAgent(id, patch));
}
