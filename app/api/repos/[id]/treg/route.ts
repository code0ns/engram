import { listRepos } from "@/lib/repos";
import { publicTregConfig, setTregConfig, type TregConfigPatch } from "@/lib/treg-config";
import { canAccessWorkspace, requireAdmin } from "@/lib/workspace-resolve";

export const dynamic = "force-dynamic";

const exists = (id: string) => listRepos().some((r) => r.id === id);

/** Treg budget for a workspace — any member granted on it may SEE the limits and today's spend
 *  (so an agent's refusal is explainable); the token itself is never returned, only `hasToken`. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await canAccessWorkspace(req, id))) return Response.json({ error: "not granted" }, { status: 403 });
  if (!exists(id)) return Response.json({ error: "workspace not found" }, { status: 404 });
  return Response.json(publicTregConfig(id));
}

/**
 * Admin-only. Body (all optional): { token, clearToken, orgId, perCallCapUsd, dailyCapUsd }.
 * `token` is write-only; null/"" for orgId or a cap resets it to the env default.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  if (!(await canAccessWorkspace(req, id))) return Response.json({ error: "not granted" }, { status: 403 });
  if (!exists(id)) return Response.json({ error: "workspace not found" }, { status: 404 });

  const b = await req.json().catch(() => null);
  if (!b || typeof b !== "object") return Response.json({ error: "JSON body required" }, { status: 400 });

  const patch: TregConfigPatch = {};
  if (typeof b.token === "string") patch.token = b.token;
  if (b.clearToken === true) patch.clearToken = true;
  if ("orgId" in b) patch.orgId = typeof b.orgId === "string" ? b.orgId : null;
  if ("perCallCapUsd" in b) patch.perCallCapUsd = b.perCallCapUsd;
  if ("dailyCapUsd" in b) patch.dailyCapUsd = b.dailyCapUsd;

  try {
    setTregConfig(id, patch);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
  return Response.json(publicTregConfig(id));
}
