import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who caused the write currently in flight.
 *
 * Agents already write to the vault autonomously, so an anonymous "edit foo.md" in the git
 * log is not an audit trail. Every write funnels through lib/vault/write.ts, which stamps
 * the current actor into the commit message — so the Activity page answers "who did this"
 * without threading an `actor` argument through every tool handler.
 *
 * Set it at the request boundary (the MCP route, the dashboard API), read it in write.ts.
 *
 * MCP calls may also carry the client's session id (the `Mcp-Session-Id` header). It is NOT part
 * of the actor — the audit trail should say who, not which chat — but it is part of the key for
 * per-session state (workspace selection, read-before-edit tracking), so two chats sharing one
 * credential stop overwriting each other's state.
 */
interface Ctx {
  actor: string;
  session?: string;
}

const storage = new AsyncLocalStorage<Ctx>();

export function withActor<T>(actor: string, fn: () => T, sessionId?: string): T {
  return storage.run({ actor, session: sessionId }, fn);
}

/** The actor for the in-flight request, or "unknown" outside any request (e.g. a git pull). */
export function currentActor(): string {
  return storage.getStore()?.actor ?? "unknown";
}

/**
 * The key for per-session state: the actor, plus the MCP session id when the client sent one. A
 * client that doesn't echo a session id still works exactly as before (state shared per actor).
 * Encoded as JSON so no actor name can collide with another actor's (actor, session) pair.
 */
export function currentSessionKey(): string {
  const ctx = storage.getStore();
  return JSON.stringify([ctx?.actor ?? "unknown", ctx?.session ?? null]);
}
