import { createAgent, listAgents, pcRoute, type CreateAgentInput } from "@/lib/paperclip/client";
import { linkAgentToEngram, type LinkEngramInput } from "@/lib/paperclip/mcp-link";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) return Response.json({ error: "companyId required" }, { status: 400 });
  return pcRoute(async () => ({ agents: await listAgents(companyId) }));
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { companyId, linkEngram, ...agentInput } = body as CreateAgentInput & {
    companyId?: string;
    linkEngram?: LinkEngramInput;
  };
  if (!companyId) return Response.json({ error: "companyId required" }, { status: 400 });
  if (!agentInput.name || !agentInput.role || !agentInput.adapterType)
    return Response.json({ error: "name, role, and adapterType required" }, { status: 400 });

  return pcRoute(async () => {
    const agent = await createAgent(companyId, agentInput);
    if (!linkEngram) return { agent };
    const origin = new URL(req.url).origin;
    const cwd = typeof agentInput.adapterConfig?.cwd === "string" ? (agentInput.adapterConfig.cwd as string) : undefined;
    const link = linkAgentToEngram({
      origin,
      agentId: agent.id,
      agentName: agent.name,
      companyId,
      cwd,
      adapterType: agent.adapterType,
      link: linkEngram,
    });
    return { agent, link };
  });
}
