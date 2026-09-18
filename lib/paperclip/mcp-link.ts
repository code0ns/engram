import fs from "node:fs";
import path from "node:path";
import { createToken, type TokenScope } from "@/lib/tokens";
import { setAgentLink } from "@/lib/paperclip/links";
import { paperclipWslDistro } from "@/lib/paperclip/settings";

/**
 * A claude_local agent's cwd is a path on whatever host actually runs Paperclip's adapter
 * process. When Paperclip runs inside WSL but Engram runs on native Windows (our own setup
 * after moving Paperclip off native Windows to dodge its .cmd-spawn bug), a Linux-looking
 * cwd like "/home/ser/foo" is NOT reachable via plain fs calls — Windows treats a leading
 * "/" as "root of the current drive" and silently writes the wrong place. Route it through
 * the \\wsl.localhost\<distro>\ UNC share instead, which Windows can read/write directly.
 */
function resolveWritablePath(cwd: string, relFile: string): string | null {
  const looksLinux = cwd.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(cwd);
  if (looksLinux && process.platform === "win32") {
    const distro = paperclipWslDistro();
    if (!distro) return null; // no distro configured — can't translate, caller falls back to manual snippet
    const winCwd = `\\\\wsl.localhost\\${distro}${cwd.replace(/\//g, "\\")}`;
    return path.join(winCwd, relFile);
  }
  return path.join(cwd, relFile);
}

/**
 * Wires a freshly-created Paperclip agent up to Engram as its memory/documentation layer:
 * mints a scoped MCP token, best-effort drops a .mcp.json into the agent's working
 * directory (claude_local only — same-machine assumption), and records the binding so the
 * Agents page can show it and the Connect page's revoke still cuts the agent off.
 */

export interface LinkEngramInput {
  scope: TokenScope;
  notePaths?: string[];
}

export interface LinkEngramResult {
  tokenId: string;
  tokenName: string;
  scope: TokenScope;
  /** True if a .mcp.json was written into the agent's cwd; false means use mcpConfigSnippet manually. */
  mcpWritten: boolean;
  mcpConfigSnippet: string;
}

export function linkAgentToEngram(opts: {
  origin: string;
  agentId: string;
  agentName: string;
  companyId: string;
  cwd?: string;
  adapterType: string;
  link: LinkEngramInput;
}): LinkEngramResult {
  const { id: tokenId, name: tokenName, scope, token } = createToken(`paperclip:${opts.agentName}`, opts.link.scope);
  const mcpUrl = `${opts.origin}/api/mcp`;
  const mcpConfigSnippet = JSON.stringify(
    { mcpServers: { engram: { url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  );

  let mcpWritten = false;
  if (opts.adapterType === "claude_local" && opts.cwd && (path.isAbsolute(opts.cwd) || opts.cwd.startsWith("/"))) {
    const target = resolveWritablePath(opts.cwd, ".mcp.json");
    if (target) {
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, mcpConfigSnippet);
        mcpWritten = true;
      } catch {
        mcpWritten = false;
      }
    }
  }

  setAgentLink({
    paperclipAgentId: opts.agentId,
    paperclipCompanyId: opts.companyId,
    engramTokenId: tokenId,
    briefingNotePaths: opts.link.notePaths ?? [],
  });

  return { tokenId, tokenName, scope, mcpWritten, mcpConfigSnippet };
}
