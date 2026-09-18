import { getAgentLink } from "@/lib/paperclip/links";

export const dynamic = "force-dynamic";

/** The local Engram<->agent binding (token id + briefing notes), not proxied to Paperclip. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return Response.json({ link: getAgentLink(id) });
}
