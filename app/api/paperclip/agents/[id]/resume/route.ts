import { pcRoute, resumeAgent } from "@/lib/paperclip/client";

export const dynamic = "force-dynamic";

export function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return pcRoute(async () => resumeAgent((await params).id));
}
