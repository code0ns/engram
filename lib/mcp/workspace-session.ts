import { currentActor, currentSessionKey } from "@/lib/actor";

/**
 * Per-session workspace selection for MCP callers.
 *
 * MCP has no persistent connection state: every `tools/call` is an independent HTTP POST.
 * This module provides the "session" that lets an agent call brain_use_workspace and have
 * subsequent calls in that session target the selected workspace, without flipping the global
 * active workspace (which would steal the dashboard user's view).
 *
 * Keyed by the authenticated actor plus the client's `Mcp-Session-Id` when it sends one
 * (lib/actor.ts currentSessionKey), aged out on a sliding window. Clients that do not echo a
 * session id share one selection per actor, i.e. per credential — which is why a per-call
 * `workspace` argument (lib/mcp/caller.ts) is the reliable way to target a vault. Deliberately
 * in-memory: a restart forgetting a workspace selection is the safe direction to fail — the call
 * carries a notice that it used the default (workspaceNotice) and the agent can re-select.
 */

/** How long a workspace selection lasts. Long enough for a multi-step task. */
const TTL_MS = 60 * 60 * 1000; // 1 hour

interface Selection {
  workspaceId: string;
  selectedAt: number;
}

const selections = new Map<string, Selection>();

/** Drop expired selections. */
function prune(now: number): void {
  for (const [key, sel] of selections) {
    if (now - sel.selectedAt > TTL_MS) selections.delete(key);
  }
}

/** Outside any request there is nobody to key a selection to. */
const anonymous = () => currentActor() === "unknown";

/**
 * Record that this session has selected a workspace. Subsequent calls to getSelectedWorkspace
 * will return this workspace ID until TTL expires or they switch again.
 */
export function selectWorkspace(workspaceId: string, now: number = Date.now()): void {
  if (anonymous()) return;
  prune(now);
  selections.set(currentSessionKey(), { workspaceId, selectedAt: now });
}

/**
 * Get the workspace this session has selected, or null if none (they'll get the default).
 * Refreshes the TTL on access (sliding window).
 */
export function getSelectedWorkspace(now: number = Date.now()): string | null {
  if (anonymous()) return null;
  prune(now);
  const key = currentSessionKey();
  const sel = selections.get(key);
  if (!sel) return null;
  if (now - sel.selectedAt > TTL_MS) {
    selections.delete(key);
    return null;
  }
  // Refresh TTL on access
  sel.selectedAt = now;
  return sel.workspaceId;
}

/**
 * Clear a workspace selection (for testing or explicit reset).
 */
export function clearSelectedWorkspace(): void {
  if (anonymous()) return;
  selections.delete(currentSessionKey());
}

/** Test seam. */
export function resetWorkspaceSessions(): void {
  selections.clear();
}
