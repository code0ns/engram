import { clearAgentError, pcRoute } from "@/lib/paperclip/client";

export const dynamic = "force-dynamic";

export function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return pcRoute(async () => clearAgentError((await params).id));
}
