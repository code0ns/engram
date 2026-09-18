import { listConfigRevisions, pcRoute } from "@/lib/paperclip/client";

export const dynamic = "force-dynamic";

export function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return pcRoute(async () => ({ revisions: await listConfigRevisions((await params).id) }));
}
