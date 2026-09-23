import { currentActor } from "@/lib/actor";

/**
 * Per-session workspace selection for MCP callers.
 *
 * MCP has no persistent connection state: every `tools/call` is an independent HTTP POST.
 * This module provides the "session" that lets an agent call brain_use_workspace and have
 * subsequent calls in that session target the selected workspace, without flipping the global
 * active workspace (which would steal the dashboard user's view).
 *
 * Keyed by the authenticated actor (lib/actor.ts), aged out on a sliding window. Same pattern
 * as lib/mcp/session.ts's read tracking. Deliberately in-memory: a restart forgetting a
 * workspace selection is the safe direction to fail — the agent sees the default workspace and
 * can re-select.
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
  for (const [actor, sel] of selections) {
    if (now - sel.selectedAt > TTL_MS) selections.delete(actor);
  }
}

/**
 * Record that this actor has selected a workspace. Subsequent calls to getSelectedWorkspace
 * will return this workspace ID until TTL expires or they switch again.
 */
export function selectWorkspace(workspaceId: string, now: number = Date.now()): void {
  const actor = currentActor();
  if (!actor || actor === "unknown") return;
  prune(now);
  selections.set(actor, { workspaceId, selectedAt: now });
}

/**
 * Get the workspace this actor has selected, or null if none (they'll get the default).
 * Refreshes the TTL on access (sliding window).
 */
export function getSelectedWorkspace(now: number = Date.now()): string | null {
  const actor = currentActor();
  if (!actor || actor === "unknown") return null;
  prune(now);
  const sel = selections.get(actor);
  if (!sel) return null;
  if (now - sel.selectedAt > TTL_MS) {
    selections.delete(actor);
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
  const actor = currentActor();
  if (!actor || actor === "unknown") return;
  selections.delete(actor);
}

/** Test seam. */
export function resetWorkspaceSessions(): void {
  selections.clear();
}
