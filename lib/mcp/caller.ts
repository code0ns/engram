import {
  resolveTokenWorkspace,
  tokenHasWorkspaceAccess,
  type ResolvedWorkspace,
  type TokenCaller,
} from "@/lib/workspace-resolve";
import { listRepos, vaultDirFor, type Repo } from "@/lib/repos";
import { getSelectedWorkspace } from "./workspace-session";

/**
 * Which workspace an MCP call lands in, and how we got there.
 *
 * Three ways, strongest first:
 *   1. `argument`  — the call itself named a workspace (`workspace`: id or exact name). Works for
 *      every client, needs no session state, and cannot be disturbed by another chat sharing the
 *      same credential.
 *   2. `selection` — brain_use_workspace earlier in this actor's session (shared by everything that
 *      uses the same credential, expires after an hour or a restart — see workspace-session.ts).
 *   3. `default`   — the credential's default resolution (lib/workspace-resolve.ts).
 *
 * `default` is the dangerous one when a credential can reach more than one workspace: the call
 * works, silently, in whichever vault happens to be the default. Callers surface that
 * (workspaceNotice) and an operator can refuse writes in that state (refuseWrite).
 */

export type WorkspaceSource = "argument" | "selection" | "default";

export interface EffectiveWorkspace {
  ws: ResolvedWorkspace;
  source: WorkspaceSource;
  /** How many workspaces this credential can use. Below 2 there is nothing to confuse. */
  reachable: number;
}

/** A bad `workspace` argument. The message is written for a model that has to fix its own call. */
export class WorkspaceArgError extends Error {}

const toResolved = (r: Repo): ResolvedWorkspace => ({ workspaceId: r.id, dir: vaultDirFor(r.id), name: r.name });

/** The workspaces this credential may use, in connection order. */
export function accessibleRepos(caller: TokenCaller): Repo[] {
  return listRepos().filter((r) => tokenHasWorkspaceAccess(caller, r.id));
}

const describe = (repos: Repo[]) => (repos.length ? repos.map((r) => `"${r.name}" (id: ${r.id})`).join(", ") : "none");

/**
 * Resolve a `workspace` argument to one of the caller's workspaces: id first, then exact name.
 *
 * Only workspaces the credential can already see are ever matched or listed, so the error for a
 * workspace that exists but isn't yours is identical to the error for one that doesn't exist — a
 * client at one customer must not learn another customer's vault names from our error text.
 * Never falls back: a wrong name is an error, not "the default workspace".
 */
export function matchWorkspaceArg(caller: TokenCaller, arg: unknown): Repo {
  if (typeof arg !== "string" || !arg.trim()) {
    throw new WorkspaceArgError(
      "`workspace` must be a non-empty string: a workspace id or its exact name. Use brain_workspaces to list them. Nothing was run.",
    );
  }
  const want = arg.trim();
  const mine = accessibleRepos(caller);
  const byId = mine.find((r) => r.id === want);
  if (byId) return byId;
  const byName = mine.filter((r) => r.name === want);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new WorkspaceArgError(
      `More than one of your workspaces is named "${want}". Pass the id instead: ${describe(byName)}. Nothing was run.`,
    );
  }
  throw new WorkspaceArgError(
    `No workspace "${want}" is available to this token. Your workspaces: ${describe(mine)}. Nothing was run.`,
  );
}

/**
 * Where this call goes. `workspaceArg` is the raw `workspace` argument (undefined/null = not given).
 * Returns null when the credential has no usable workspace at all. Throws WorkspaceArgError for a
 * bad argument — which must never degrade into a silent fallback.
 */
export function resolveEffective(caller: TokenCaller, workspaceArg?: unknown): EffectiveWorkspace | null {
  const mine = accessibleRepos(caller);
  const reachable = mine.length;

  if (workspaceArg !== undefined && workspaceArg !== null) {
    return { ws: toResolved(matchWorkspaceArg(caller, workspaceArg)), source: "argument", reachable };
  }

  const selectedId = getSelectedWorkspace();
  if (selectedId) {
    // A selection is only honoured while the credential can still use it (access revoked or the
    // workspace deleted since it was chosen — then it falls through to the default, with a notice).
    const repo = mine.find((r) => r.id === selectedId);
    if (repo) return { ws: toResolved(repo), source: "selection", reachable };
  }

  const fallback = resolveTokenWorkspace(caller);
  return fallback ? { ws: fallback, source: "default", reachable } : null;
}

/**
 * One line telling the caller its call fell through to the default workspace, when that is a
 * guess — i.e. it could have meant any of several. Null when nothing needs saying.
 */
export function workspaceNotice(eff: EffectiveWorkspace): string | null {
  if (eff.source !== "default" || eff.reachable < 2) return null;
  return (
    `Notice: this call named no workspace and none is selected for this session, so it ran in the ` +
    `default workspace "${eff.ws.name}". This token can reach ${eff.reachable} workspaces. Pass ` +
    `\`workspace\` (id or exact name) on the call, or run brain_use_workspace, to choose explicitly. ` +
    `See brain_workspaces.`
  );
}

/**
 * Operator opt-in: refuse *writes* that would land in the default workspace by guesswork. Off
 * unless MCP_REQUIRE_WORKSPACE_FOR_WRITES=true — turning it on breaks every agent that has never
 * named a workspace, so flip it once credentials are pinned (Access > Agent connections).
 * Returns the refusal message, or null to proceed.
 */
export function refuseWrite(toolName: string, eff: EffectiveWorkspace): string | null {
  if (process.env.MCP_REQUIRE_WORKSPACE_FOR_WRITES !== "true") return null;
  if (eff.source !== "default" || eff.reachable < 2) return null;
  return (
    `${toolName} was not run: it would write to the default workspace "${eff.ws.name}" by guesswork — ` +
    `the call named no workspace, none is selected, and this token can reach ${eff.reachable}. ` +
    `Pass \`workspace\` (id or exact name) or run brain_use_workspace first. Nothing was written.`
  );
}

// ── the `workspace` argument as a wire concern ────────────────────────────────────────────────
// Tools validate their arguments strictly (lib/mcp/call.ts rejects unknown keys), so the per-call
// `workspace` is handled here, once, at the route: advertised on every tool's schema, stripped from
// the arguments before validation, and resolved before the handler runs.

/** Tools that manage the selection itself and so take no per-call workspace. */
export const NO_WORKSPACE_ARG = new Set(["brain_workspaces", "brain_use_workspace"]);

export const WORKSPACE_ARG_DESCRIPTION =
  "Optional. Which workspace (vault) this call targets: its id or exact name from brain_workspaces. " +
  "Overrides brain_use_workspace for this call only. Omit to use the selected workspace, else the default. " +
  "Pass it whenever more than one session may be using this token.";

/** A copy of a tool's input schema with the optional `workspace` property added. */
export function withWorkspaceArg(schema: Record<string, unknown>): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  return { ...schema, properties: { ...props, workspace: { type: "string", description: WORKSPACE_ARG_DESCRIPTION } } };
}

/** Take `workspace` out of a tool call's raw arguments. Non-object arguments pass through untouched
 *  so the tool's own validation still reports them. */
export function splitWorkspaceArg(raw: unknown): { workspace: unknown; args: unknown } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { workspace: undefined, args: raw };
  const { workspace, ...rest } = raw as Record<string, unknown>;
  return { workspace, args: rest };
}

/** MCP result content: the tool's output, plus the workspace notice as a second block when there is one. */
export function contentWithNotice(text: string, notice: string | null): { type: "text"; text: string }[] {
  const blocks: { type: "text"; text: string }[] = [{ type: "text", text }];
  if (notice) blocks.push({ type: "text", text: notice });
  return blocks;
}

/**
 * A client-supplied `Mcp-Session-Id`, or undefined when absent or unusable. Visible ASCII only and
 * bounded, since it comes straight off the wire. It only ever namespaces state *within* the
 * authenticated actor, and every workspace choice is re-validated against the credential's access on
 * each call — so a forged or guessed id can't reach anything the credential couldn't already.
 */
export function sanitizeSessionId(raw: string | null | undefined): string | undefined {
  const v = raw?.trim();
  return v && v.length <= 128 && /^[\x21-\x7e]+$/.test(v) ? v : undefined;
}

/** A fresh session id, handed to the client on `initialize` (streamable-HTTP transport). */
export const newSessionId = () => crypto.randomUUID();

/** The audit/selection identity for an OAuth caller: per person, not one shared literal "oauth". */
export const oauthActor = (sub: string) => `oauth:${sub}`;
