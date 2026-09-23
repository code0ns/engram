import fs from "node:fs";
import path from "node:path";
import {
  tokenHasWorkspaceAccess,
  grantedWorkspacesFor,
  type TokenCaller,
  type ResolvedWorkspace,
} from "@/lib/workspace-resolve";
import { listRepos, getActive, vaultDirFor, type Repo } from "@/lib/repos";
import { isAllowed } from "@/lib/auth";
import { listNotes } from "@/lib/vault/store";
import { selectWorkspace, getSelectedWorkspace, clearSelectedWorkspace } from "./workspace-session";
import { syncStatus } from "@/lib/git";

/**
 * Workspace management tools for MCP callers.
 *
 * These tools let agents discover which workspaces they can access and switch between them
 * without reconnecting. Unlike the brain_* content tools, these operate on metadata and need
 * access to the caller's identity to enforce access control.
 */

export interface WorkspaceTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** These tools don't mutate vault content, but brain_use_workspace mutates session state. */
  write?: boolean;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  fullName?: string;
  branch: string;
  /** True when this is the globally active workspace in the dashboard. */
  globalActive: boolean;
  /** True when this caller's token/identity has access to this workspace. */
  accessible: boolean;
  /** True when this workspace is the current call's resolved workspace (before any session override). */
  current?: boolean;
  /** Note count in the workspace, if available. */
  noteCount?: number;
  /** Clone status: present if the local clone is empty or missing. */
  cloneStatus?: "empty" | "missing";
  /** Last sync error for this workspace, if any. */
  syncError?: string;
}

function repoToWorkspaceInfo(
  r: Repo,
  caller: TokenCaller,
  currentWorkspaceId: string | null,
  globalActiveId: string | null,
): WorkspaceInfo {
  const accessible = tokenHasWorkspaceAccess(caller, r.id);
  const dir = vaultDirFor(r.id);

  // Check clone status
  let cloneStatus: "empty" | "missing" | undefined;
  const gitDir = path.join(dir, ".git");
  if (!fs.existsSync(dir)) {
    cloneStatus = "missing";
  } else if (!fs.existsSync(gitDir)) {
    cloneStatus = "missing";
  } else {
    // Check if the clone is empty (no files besides .git)
    try {
      const entries = fs.readdirSync(dir).filter((e) => e !== ".git" && e !== ".gitkeep");
      if (entries.length === 0) {
        cloneStatus = "empty";
      }
    } catch {
      cloneStatus = "missing";
    }
  }

  // Get note count if accessible and clone exists
  let noteCount: number | undefined;
  if (accessible && !cloneStatus) {
    try {
      noteCount = listNotes(dir).length;
    } catch {
      // Ignore - noteCount stays undefined
    }
  }

  return {
    id: r.id,
    name: r.name,
    fullName: r.fullName,
    branch: r.branch,
    globalActive: r.id === globalActiveId,
    accessible,
    current: r.id === currentWorkspaceId,
    ...(noteCount !== undefined ? { noteCount } : {}),
    ...(cloneStatus ? { cloneStatus } : {}),
  };
}

/**
 * List workspaces this caller can access.
 *
 * For shared/unscoped named/local tokens: all connected workspaces (operator full access).
 * For scoped named tokens: only the workspaces in their list.
 * For OAuth tokens: only workspaces granted to their email.
 */
export function listAccessibleWorkspaces(
  caller: TokenCaller,
  currentWorkspace: ResolvedWorkspace | null,
): { workspaces: WorkspaceInfo[]; selected: string | null; current: string | null } {
  const allRepos = listRepos();
  const globalActive = getActive();
  const globalActiveId = globalActive?.id ?? null;
  const currentId = currentWorkspace?.workspaceId ?? null;
  const selectedId = getSelectedWorkspace();

  let workspaces: WorkspaceInfo[];

  switch (caller.kind) {
    case "local":
    case "shared":
      // Full access to all workspaces
      workspaces = allRepos.map((r) => repoToWorkspaceInfo(r, caller, currentId, globalActiveId));
      break;

    case "named": {
      if (!caller.workspaceIds || caller.workspaceIds.length === 0) {
        // Unscoped legacy token - full access
        workspaces = allRepos.map((r) => repoToWorkspaceInfo(r, caller, currentId, globalActiveId));
      } else {
        // Scoped to specific workspaces
        workspaces = allRepos
          .filter((r) => caller.workspaceIds.includes(r.id))
          .map((r) => repoToWorkspaceInfo(r, caller, currentId, globalActiveId));
      }
      break;
    }

    case "oauth": {
      if (!isAllowed(caller.email)) {
        workspaces = [];
        break;
      }
      const grantedIds = new Set(grantedWorkspacesFor(caller.email).map((r) => r.id));
      workspaces = allRepos
        .filter((r) => grantedIds.has(r.id))
        .map((r) => repoToWorkspaceInfo(r, caller, currentId, globalActiveId));
      break;
    }
  }

  return {
    workspaces,
    selected: selectedId,
    current: currentId,
  };
}

/**
 * Select a workspace for subsequent MCP calls in this session.
 *
 * Returns error if the caller doesn't have access to the workspace or it doesn't exist.
 */
export async function useWorkspace(
  caller: TokenCaller,
  workspaceId: string,
  setGlobalActive: boolean = false,
): Promise<{ ok: true; workspaceId: string; name: string; warning?: string } | { ok: false; error: string }> {
  // Check workspace exists
  const repos = listRepos();
  const repo = repos.find((r) => r.id === workspaceId);
  if (!repo) {
    return { ok: false, error: `workspace not found: ${workspaceId}` };
  }

  // Check access
  if (!tokenHasWorkspaceAccess(caller, workspaceId)) {
    return { ok: false, error: `access denied to workspace: ${repo.name} (${workspaceId})` };
  }

  // Check clone status
  const dir = vaultDirFor(workspaceId);
  if (!fs.existsSync(path.join(dir, ".git"))) {
    return {
      ok: false,
      error: `workspace clone is missing or incomplete: ${repo.name}. The operator needs to re-clone this workspace.`,
    };
  }

  // Check if clone is empty
  try {
    const entries = fs.readdirSync(dir).filter((e) => e !== ".git" && e !== ".gitkeep");
    if (entries.length === 0) {
      // Allow selection but warn - the workspace may have been connected to an empty repo
      selectWorkspace(workspaceId);

      let warning = `workspace "${repo.name}" is empty (no notes). `;
      if (repo.fullName) {
        warning += `If you expected content from ${repo.fullName}, the remote repo may be empty or sync may have failed. `;
      }
      warning += "You can still write notes here.";

      // Check sync status for any errors
      const status = await syncStatus(dir);
      if ("lastError" in status && status.lastError) {
        warning += ` Last sync error: ${status.lastError}`;
      }

      return { ok: true, workspaceId, name: repo.name, warning };
    }
  } catch {
    // If we can't read the directory, proceed anyway - the error will surface on first tool call
  }

  // Store selection in session
  selectWorkspace(workspaceId);

  // Optionally set global active (dangerous - affects dashboard)
  if (setGlobalActive) {
    const { setActive } = await import("@/lib/repos");
    setActive(workspaceId);
    return {
      ok: true,
      workspaceId,
      name: repo.name,
      warning:
        "set_global_active=true changed the dashboard's active workspace. Other users will see this workspace in the UI.",
    };
  }

  return { ok: true, workspaceId, name: repo.name };
}

/**
 * Clear the workspace selection for this session (return to default resolution).
 */
export function clearWorkspaceSelection(): { ok: true } {
  clearSelectedWorkspace();
  return { ok: true };
}

const s = (description: string) => ({ type: "string", description });

export const WORKSPACE_TOOLS: WorkspaceTool[] = [
  {
    name: "brain_workspaces",
    description:
      "List all workspaces (vaults) this token can access. Returns each workspace's id, name, fullName (GitHub repo), branch, whether it's the global active workspace, whether this caller has access, whether it's the current session's workspace, and note count. Use this to discover available vaults before switching. `selected` shows the workspace this session has explicitly selected (via brain_use_workspace); `current` shows what the default resolution picked.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "brain_use_workspace",
    description:
      "Select a workspace for subsequent MCP calls in this session. Pass the workspace `id` from brain_workspaces. This sets a per-session workspace that overrides the default resolution until the session expires (1 hour) or you switch again. Does NOT change the dashboard's global active workspace unless you pass `set_global_active: true` (dangerous — affects what other users see). Returns error if you don't have access to the workspace or it doesn't exist.",
    inputSchema: {
      type: "object",
      properties: {
        id: s("the workspace ID to switch to (from brain_workspaces)"),
        set_global_active: {
          type: "boolean",
          description:
            "also flip the global active workspace (affects dashboard). Default false. Only for operator tokens that intend to change what all users see.",
        },
      },
      required: ["id"],
    },
    write: true, // Modifies session state
  },
];

export const WORKSPACE_TOOL_MAP = new Map(WORKSPACE_TOOLS.map((t) => [t.name, t]));
