import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "@/lib/config";

/**
 * Records which Paperclip agent is bound to which Engram MCP token (and, for display,
 * which vault notes it was briefed with). Kept separate from lib/tokens.ts so the token
 * model itself stays free of Paperclip-specific fields — this store is just an overlay.
 */

const STATE_DIR = process.env.ENGRAM_STATE_DIR || DATA_ROOT;
const LINKS_FILE = path.join(STATE_DIR, "paperclip-links.json");

export interface AgentLink {
  paperclipAgentId: string;
  paperclipCompanyId: string;
  /** id into lib/tokens.ts — revoking it from the Connect page also cuts this agent off. */
  engramTokenId: string;
  /** Vault paths the agent was briefed with at link time, for display only. */
  briefingNotePaths: string[];
}

function load(): AgentLink[] {
  try {
    return JSON.parse(fs.readFileSync(LINKS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function save(links: AgentLink[]): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2));
}

export function listAgentLinks(): AgentLink[] {
  return load();
}

export function getAgentLink(paperclipAgentId: string): AgentLink | null {
  return load().find((l) => l.paperclipAgentId === paperclipAgentId) ?? null;
}

export function setAgentLink(link: AgentLink): void {
  const links = load().filter((l) => l.paperclipAgentId !== link.paperclipAgentId);
  links.push(link);
  save(links);
}

export function removeAgentLink(paperclipAgentId: string): void {
  save(load().filter((l) => l.paperclipAgentId !== paperclipAgentId));
}
