import { MCP_TOKEN } from "@/lib/config";
import { harnessEnabled } from "@/lib/settings";
import { hasAnyToken, resolveToken, type TokenScope } from "@/lib/tokens";
import { oauthEnabled, verifyAccessToken, wwwAuthenticate } from "@/lib/oauth";
import { withActor } from "@/lib/actor";
import { VERSION } from "@/lib/version";
import { getTool, visibleTools } from "@/lib/mcp/tools";
import { callTool } from "@/lib/mcp/call";
import { serverInstructions } from "@/lib/mcp/instructions";
import { resolveTregConfig, tregEnabled } from "@/lib/treg";
import { resolveTokenWorkspace, type TokenCaller, type ResolvedWorkspace } from "@/lib/workspace-resolve";
import {
  NO_WORKSPACE_ARG,
  contentWithNotice,
  newSessionId,
  oauthActor,
  refuseWrite,
  resolveEffective,
  sanitizeSessionId,
  splitWorkspaceArg,
  withWorkspaceArg,
  workspaceNotice,
} from "@/lib/mcp/caller";
import {
  WORKSPACE_TOOL_MAP,
  WORKSPACE_TOOLS,
  listAccessibleWorkspaces,
  switchToWorkspace,
  getWorkspaceSyncStatus,
  triggerWorkspaceSync,
} from "@/lib/mcp/workspace-tools";

export const dynamic = "force-dynamic";

const PROTOCOL = "2025-06-18";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** The authenticated caller: a name for the audit trail, what it may do, and which
 *  workspace its credential is pinned to (lib/workspace-resolve.ts). */
interface Caller {
  name: string;
  scope: TokenScope;
  workspace: TokenCaller;
}

function rpc(id: Json, result?: Json, error?: Json) {
  const msg: Json = { jsonrpc: "2.0", id: id ?? null };
  if (error) msg.error = error;
  else msg.result = result;
  return msg;
}

/**
 * The tools this caller sees — shared by tools/list and the initialize instructions, so the
 * instructions never name a tool the client can't call.
 */
function toolsFor(caller: Caller) {
  // Treg tools show only when this caller's workspace has a Treg token (own or shared). The list
  // can't vary per call, so it follows the workspace the caller would land in with no argument.
  const eff = resolveEffective(caller.workspace);
  const tregOn = eff ? tregEnabled(resolveTregConfig(eff.ws.workspaceId)) : false;
  const tools = visibleTools(caller.scope === "write", harnessEnabled(), tregOn);
  // Workspace tools are always visible (read-scope sees list, write-scope sees both).
  const wkTools = WORKSPACE_TOOLS.filter((t) => !t.write || caller.scope === "write");
  return [...tools, ...wkTools];
}

async function handleMessage(
  msg: Json,
  caller: Caller,
  defaultWorkspace: ResolvedWorkspace,
): Promise<Json | null> {
  const method: string | undefined = msg?.method;
  const id = msg?.id;
  const params = msg?.params;
  if (!method) return null;
  if (method.startsWith("notifications/")) return null; // notifications get no response

  switch (method) {
    case "initialize":
      return rpc(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "engram", version: VERSION },
        instructions: serverInstructions(
          toolsFor(caller).map((t) => t.name),
          { multiWorkspace: (resolveEffective(caller.workspace)?.reachable ?? 0) >= 2 },
        ),
      });
    case "ping":
      return rpc(id, {});
    case "tools/list":
      return rpc(id, {
        tools: toolsFor(caller).map((t) => ({
          name: t.name,
          description: t.description,
          // Every tool that works inside a workspace also takes an optional per-call `workspace`.
          inputSchema: NO_WORKSPACE_ARG.has(t.name) ? t.inputSchema : withWorkspaceArg(t.inputSchema),
        })),
      });
    case "tools/call": {
      const toolName = params?.name;

      // Handle workspace tools specially - they need caller info, not just dir
      const wkTool = WORKSPACE_TOOL_MAP.get(toolName);
      if (wkTool) {
        if (wkTool.write && caller.scope !== "write") {
          return rpc(id, undefined, {
            code: -32001,
            message: `${wkTool.name} modifies session state, and this token is read-only.`,
          });
        }
        try {
          // Actor context is already set by the outer withActor in POST
          let out: unknown;
          let notice: string | null = null;
          // brain_sync / brain_sync_status work inside one workspace, so they take `workspace` too.
          const { workspace: wsArg } = splitWorkspaceArg(params?.arguments ?? {});
          if (toolName === "brain_workspaces") {
            out = listAccessibleWorkspaces(caller.workspace, defaultWorkspace, resolveEffective(caller.workspace));
          } else if (toolName === "brain_use_workspace") {
            const args = params?.arguments ?? {};
            const workspaceId = String(args.id ?? "");
            const setGlobalActive = args.set_global_active === true;
            if (!workspaceId) {
              out = { ok: false, error: "id is required" };
            } else {
              out = await switchToWorkspace(caller.workspace, workspaceId, setGlobalActive);
            }
          } else if (toolName === "brain_sync_status") {
            // Sync status needs the effective workspace dir
            const eff = resolveEffective(caller.workspace, wsArg);
            if (!eff) {
              out = { ok: false, error: "no workspace access for this token" };
            } else {
              notice = workspaceNotice(eff);
              out = await getWorkspaceSyncStatus(eff.ws.dir);
            }
          } else if (toolName === "brain_sync") {
            // Trigger sync needs the effective workspace dir
            const eff = resolveEffective(caller.workspace, wsArg);
            if (!eff) {
              out = { ok: false, error: "no workspace access for this token" };
            } else {
              const refusal = refuseWrite(toolName, eff);
              if (refusal) throw new Error(refusal);
              notice = workspaceNotice(eff);
              out = await triggerWorkspaceSync(eff.ws.dir, `${caller.name}: MCP sync request`);
            }
          } else {
            out = { error: `unknown workspace tool: ${toolName}` };
          }
          const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
          return rpc(id, { content: contentWithNotice(text, notice) });
        } catch (e) {
          return rpc(id, { content: [{ type: "text", text: `Error: ${(e as Error)?.message ?? e}` }], isError: true });
        }
      }

      // Regular brain_* tools
      const tool = getTool(toolName);
      if (!tool) return rpc(id, undefined, { code: -32602, message: `unknown tool: ${toolName}` });
      if (tool.write && caller.scope !== "write") {
        return rpc(id, undefined, {
          code: -32001,
          message: `${tool.name} mutates the vault, and this token is read-only. Ask the operator for a write token.`,
        });
      }
      if (tool.name === "brain_capture" && !harnessEnabled()) {
        return rpc(id, undefined, { code: -32601, message: "brain_capture is off — the operator has not enabled it." });
      }
      try {
        // Where this call goes: its own `workspace` argument, else the session's selection, else the
        // default. A bad argument throws (caught below as an error result) — never a silent fallback.
        // `workspace` is removed from the arguments here so each tool's strict validation still sees
        // exactly the parameters it declares.
        const { workspace: wsArg, args: toolArgs } = splitWorkspaceArg(params?.arguments ?? {});
        const eff = resolveEffective(caller.workspace, wsArg);
        if (!eff) {
          return rpc(id, undefined, { code: -32001, message: "no workspace access for this token" });
        }
        const refusal = tool.write ? refuseWrite(tool.name, eff) : null;
        if (refusal) throw new Error(refusal);
        // Actor context is already set by the outer withActor in POST — this stamps every write
        // this call causes with the caller's name, for the git audit trail. callTool validates
        // `arguments` against the tool's inputSchema first — a malformed call must surface as an
        // error, never as a successful no-op write.
        const out = await callTool(tool.name, (toolArgs ?? {}) as Record<string, unknown>, {
          dir: eff.ws.dir,
          workspaceId: eff.ws.workspaceId,
        });
        const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
        return rpc(id, { content: contentWithNotice(text, workspaceNotice(eff)) });
      } catch (e) {
        return rpc(id, { content: [{ type: "text", text: `Error: ${(e as Error)?.message ?? e}` }], isError: true });
      }
    }
    default:
      return rpc(id, undefined, { code: -32601, message: `method not found: ${method}` });
  }
}

function jsonResponse(body: Json, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extraHeaders } });
}

/**
 * Resolve a credential to a caller, or null when it is not valid. A named per-teammate token
 * carries its own scope; the shared env token and OAuth sessions are full-access, and an
 * unauthenticated local instance (no auth configured at all) is treated as the operator.
 */
async function authenticate(token: string, authRequired: boolean): Promise<Caller | null> {
  if (!authRequired) return { name: "local", scope: "write", workspace: { kind: "local" } };
  if (!token) return null;
  if (MCP_TOKEN !== "" && token === MCP_TOKEN) return { name: "shared-token", scope: "write", workspace: { kind: "shared" } };
  const named = resolveToken(token);
  if (named) return { name: named.name, scope: named.scope, workspace: { kind: "named", workspaceIds: named.workspaceIds } };
  if (oauthEnabled()) {
    const at = await verifyAccessToken(token);
    // Per person, not one shared "oauth": workspace selections and read-before-edit tracking are
    // keyed by this name, and it is what the git audit trail records.
    if (at) return { name: oauthActor(at.sub), scope: "write", workspace: { kind: "oauth", email: at.sub } };
  }
  return null;
}

/** 401 that also advertises the OAuth flow (WWW-Authenticate) so connectors can discover it. */
function unauthorized(): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (oauthEnabled()) headers["WWW-Authenticate"] = wwwAuthenticate();
  return new Response(JSON.stringify(rpc(null, undefined, { code: -32001, message: "unauthorized" })), { status: 401, headers });
}

export async function POST(req: Request) {
  // Enforce auth when any is configured (env MCP_TOKEN, a team token, or OAuth). Open
  // locally when nothing is set. On failure, advertise OAuth so Claude.ai can connect.
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const authRequired = MCP_TOKEN !== "" || hasAnyToken() || oauthEnabled();
  const caller = await authenticate(token, authRequired);
  if (!caller) return unauthorized();

  // Resolve the default workspace (before any session override) - used for workspace tools to
  // show what the "current" workspace would be without explicit selection.
  const defaultWs = resolveTokenWorkspace(caller.workspace);
  if (!defaultWs) return jsonResponse(rpc(null, undefined, { code: -32001, message: "no workspace access for this token" }), 403);

  let body: Json;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(rpc(null, undefined, { code: -32700, message: "parse error" }), 400);
  }

  // Session id (streamable-HTTP transport). `initialize` starts a session, so the server issues the
  // id then (`Mcp-Session-Id` response header); a client that echoes it gets its own workspace
  // selection and read tracking. One that doesn't still works, sharing state per credential. The id
  // is only a namespace — unknown or stale ids are not rejected, they simply have empty state.
  const isInit = !Array.isArray(body) && body?.method === "initialize";
  const sessionId = isInit ? newSessionId() : sanitizeSessionId(req.headers.get("mcp-session-id"));

  // Each message is handled with actor context so session workspace selection works
  if (Array.isArray(body)) {
    const out = await Promise.all(
      body.map((m) => withActor(caller.name, () => handleMessage(m, caller, defaultWs), sessionId)),
    );
    const filtered = out.filter(Boolean);
    return filtered.length === 0 ? new Response(null, { status: 202 }) : jsonResponse(filtered);
  }
  const res = await withActor(caller.name, () => handleMessage(body, caller, defaultWs), sessionId);
  return res ? jsonResponse(res, 200, isInit && sessionId ? { "Mcp-Session-Id": sessionId } : {}) : new Response(null, { status: 202 });
}

// This server is request/response only (no server-initiated SSE stream). When OAuth is on,
// answer probes with a 401 that advertises the flow so connectors can discover it.
export function GET() {
  if (oauthEnabled()) {
    return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": wwwAuthenticate() } });
  }
  return new Response("Method Not Allowed", { status: 405 });
}
