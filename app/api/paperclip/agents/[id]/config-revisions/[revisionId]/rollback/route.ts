import { pcRoute, rollbackConfigRevision } from "@/lib/paperclip/client";

export const dynamic = "force-dynamic";

export function POST(_req: Request, { params }: { params: Promise<{ id: string; revisionId: string }> }) {
  return pcRoute(async () => {
    const { id, revisionId } = await params;
    return rollbackConfigRevision(id, revisionId);
  });
}
