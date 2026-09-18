import { pcRoute, rejectApproval } from "@/lib/paperclip/client";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { decisionNote } = await req.json().catch(() => ({}));
  return pcRoute(() => rejectApproval(id, decisionNote));
}
