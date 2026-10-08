import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { POST } from "@/app/api/mcp/route";
import { createToken } from "@/lib/tokens";
import { resetWorkspaceSessions } from "./workspace-session";
import { resetSessions } from "./session";

/**
 * Workspace isolation through the real MCP route: two vaults, real bearer tokens, real JSON-RPC.
 * Covers the acceptance cases of docs/handoff-2026-10-08-workspace-session-isolation.md that do not
 * depend on the client echoing an Mcp-Session-Id.
 */

const DATA = process.env.ENGRAM_DATA_DIR!;
const A = { id: "iso-a", name: "Iso Alpha" };
const B = { id: "iso-b", name: "Iso Beta" };

let seq = 0;
/** A fresh token name per test: selections and read tracking are keyed by it. */
const tokenName = (label: string) => `iso-${label}-${++seq}`;

beforeAll(() => {
  fs.mkdirSync(DATA, { recursive: true });
  const repo = (r: { id: string; name: string }, active: boolean) => ({
    ...r,
    url: `https://example.com/${r.id}.git`,
    branch: "main",
    active,
    addedAt: "2026-01-01",
  });
  fs.writeFileSync(path.join(DATA, "repos.json"), JSON.stringify([repo(A, true), repo(B, false)]));
  for (const [r, own] of [
    [A, "only-in-alpha.md"],
    [B, "only-in-beta.md"],
  ] as const) {
    const dir = path.join(DATA, "vaults", r.id);
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true }); // brain_use_workspace checks for a clone
    fs.writeFileSync(path.join(dir, own), `# ${own}\n\nlives in ${r.name}\n`);
    fs.writeFileSync(path.join(dir, "shared.md"), `# Shared\n\noriginal text in ${r.name}\n`);
  }
});

afterEach(() => {
  delete process.env.MCP_REQUIRE_WORKSPACE_FOR_WRITES;
  resetWorkspaceSessions();
  resetSessions();
});

interface RpcResult {
  result?: { content?: { type: string; text: string }[]; tools?: { name: string; inputSchema: { properties: Record<string, unknown> } }[]; isError?: boolean };
  error?: { message: string };
}

/** POST one JSON-RPC message, optionally as part of an MCP session (the client echoing Mcp-Session-Id). */
function post(token: string, method: string, params?: unknown, sessionId?: string): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return POST(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
}

async function rpc(token: string, method: string, params?: unknown, sessionId?: string): Promise<RpcResult> {
  return (await (await post(token, method, params, sessionId)).json()) as RpcResult;
}

const call = (token: string, name: string, args: Record<string, unknown> = {}, sessionId?: string) =>
  rpc(token, "tools/call", { name, arguments: args }, sessionId);
const text = (r: RpcResult) => r.result?.content?.[0]?.text ?? "";
const blocks = (r: RpcResult) => r.result?.content ?? [];

describe("per-call `workspace` argument", () => {
  test("targets the named workspace, by id or exact name, whatever the default is", async () => {
    const { token } = createToken(tokenName("target"), "write");
    const inBeta = await call(token, "brain_list", { workspace: B.id });
    expect(text(inBeta)).toContain("only-in-beta.md");
    expect(text(inBeta)).not.toContain("only-in-alpha.md");

    const inAlpha = await call(token, "brain_list", { workspace: A.name });
    expect(text(inAlpha)).toContain("only-in-alpha.md");
    expect(text(inAlpha)).not.toContain("only-in-beta.md");
  });

  test("a named workspace carries no fallback notice", async () => {
    const { token } = createToken(tokenName("nonotice"), "write");
    expect(blocks(await call(token, "brain_list", { workspace: B.id }))).toHaveLength(1);
  });

  test("overrides a brain_use_workspace selection for that call only", async () => {
    const { token } = createToken(tokenName("override"), "write");
    await call(token, "brain_use_workspace", { id: B.id });

    expect(text(await call(token, "brain_list"))).toContain("only-in-beta.md");
    expect(text(await call(token, "brain_list", { workspace: A.id }))).toContain("only-in-alpha.md");
    // The one-off override did not move the selection.
    expect(text(await call(token, "brain_list"))).toContain("only-in-beta.md");
  });

  test("a workspace this token cannot use is an error — never a fallback, and no leak of other names", async () => {
    const { token } = createToken(tokenName("pinned"), "write", [A.id]);
    const res = await call(token, "brain_list", { workspace: B.id });
    expect(res.result?.isError).toBe(true);
    const msg = text(res);
    expect(msg).toContain("Nothing was run");
    expect(msg).toContain(A.name);
    // The error echoes the id the caller sent, but the list of available workspaces must be only theirs.
    expect(msg).not.toContain(B.name);
    expect(msg.split("Your workspaces:")[1]).not.toContain(B.id);
    expect(msg).not.toContain("only-in-alpha.md"); // and nothing ran against the default either
  });

  test("an unknown workspace is the same kind of error", async () => {
    const { token } = createToken(tokenName("unknown"), "write");
    const res = await call(token, "brain_list", { workspace: "does-not-exist" });
    expect(res.result?.isError).toBe(true);
    expect(text(res)).toContain("does-not-exist");
  });

  test("works for the sync tools too", async () => {
    const { token } = createToken(tokenName("sync"), "write");
    const res = await call(token, "brain_sync_status", { workspace: B.id });
    expect(res.result?.isError).toBeFalsy();
    expect(text(res)).toContain("enabled");
  });

  test("other arguments are still validated strictly", async () => {
    const { token } = createToken(tokenName("strict"), "write");
    const res = await call(token, "brain_read", { path: "shared.md", bogus: 1, workspace: A.id });
    expect(res.result?.isError).toBe(true);
    expect(text(res)).toContain("bogus");
  });

  test("tools/list advertises it on workspace tools, and not on the selection tools", async () => {
    const { token } = createToken(tokenName("list"), "write");
    const tools = (await rpc(token, "tools/list")).result!.tools!;
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("brain_read")!.inputSchema.properties).toHaveProperty("workspace");
    expect(byName.get("brain_sync")!.inputSchema.properties).toHaveProperty("workspace");
    expect(byName.get("brain_use_workspace")!.inputSchema.properties).not.toHaveProperty("workspace");
    expect(byName.get("brain_workspaces")!.inputSchema.properties).not.toHaveProperty("workspace");
  });
});

describe("no silent fallback", () => {
  test("a call that lands on the default of a multi-workspace token carries a notice naming it", async () => {
    const { token } = createToken(tokenName("notice"), "write");
    const res = await call(token, "brain_list");
    expect(text(res)).toContain("only-in-alpha.md"); // the default (active) workspace
    expect(blocks(res)).toHaveLength(2);
    expect(blocks(res)[1].text).toContain(`"${A.name}"`);
    // the first block is still the tool's own JSON, untouched
    expect(() => JSON.parse(text(res))).not.toThrow();
  });

  test("no notice once a workspace is selected", async () => {
    const { token } = createToken(tokenName("selected"), "write");
    await call(token, "brain_use_workspace", { id: B.id });
    expect(blocks(await call(token, "brain_list"))).toHaveLength(1);
  });

  test("no notice for a token pinned to a single workspace", async () => {
    const { token } = createToken(tokenName("single"), "write", [A.id]);
    expect(blocks(await call(token, "brain_list"))).toHaveLength(1);
  });

  test("writes are allowed by default, but refused when the operator requires a workspace", async () => {
    const { token } = createToken(tokenName("flag"), "write");

    const allowed = await call(token, "brain_write", { path: "flag-off.md", content: "# off\n\nok\n" });
    expect(allowed.result?.isError).toBeFalsy();

    process.env.MCP_REQUIRE_WORKSPACE_FOR_WRITES = "true";
    const refused = await call(token, "brain_write", { path: "flag-on.md", content: "# on\n\nnope\n" });
    expect(refused.result?.isError).toBe(true);
    expect(text(refused)).toContain("Nothing was written");
    expect(fs.existsSync(path.join(DATA, "vaults", A.id, "flag-on.md"))).toBe(false);

    const named = await call(token, "brain_write", { path: "flag-named.md", content: "# named\n\nok\n", workspace: B.id });
    expect(named.result?.isError).toBeFalsy();
    expect(fs.existsSync(path.join(DATA, "vaults", B.id, "flag-named.md"))).toBe(true);

    // reads are never blocked
    expect(text(await call(token, "brain_list"))).toContain("only-in-alpha.md");
  });
});

describe("brain_workspaces reports where the next call really goes", () => {
  test("`effective` follows the selection while `default` stays put", async () => {
    const { token } = createToken(tokenName("report"), "write");

    const before = JSON.parse(text(await call(token, "brain_workspaces")));
    expect(before.effective).toMatchObject({ id: A.id, source: "default" });
    expect(before.default).toBe(A.id);

    await call(token, "brain_use_workspace", { id: B.id });
    const after = JSON.parse(text(await call(token, "brain_workspaces")));
    expect(after.effective).toMatchObject({ id: B.id, source: "selection" });
    expect(after.selected).toBe(B.id);
    expect(after.default).toBe(A.id); // not where calls go — this is the trap the old `current` set
    expect(after.workspaces.filter((w: { effective?: boolean }) => w.effective).map((w: { id: string }) => w.id)).toEqual([B.id]);
  });
});

describe("credentials do not share selections", () => {
  test("two tokens select different workspaces without interfering", async () => {
    const t1 = createToken(tokenName("one"), "write").token;
    const t2 = createToken(tokenName("two"), "write").token;
    await call(t1, "brain_use_workspace", { id: B.id });
    expect(text(await call(t1, "brain_list"))).toContain("only-in-beta.md");
    expect(text(await call(t2, "brain_list"))).toContain("only-in-alpha.md"); // t2 never selected
  });
});

describe("MCP sessions (clients that echo Mcp-Session-Id)", () => {
  test("initialize issues a fresh session id; other calls do not", async () => {
    const { token } = createToken(tokenName("init"), "write");
    const init1 = await post(token, "initialize", { protocolVersion: "2025-06-18" });
    const init2 = await post(token, "initialize", { protocolVersion: "2025-06-18" });
    const id1 = init1.headers.get("mcp-session-id");
    expect(id1).toMatch(/^[0-9a-f-]{36}$/);
    expect(init2.headers.get("mcp-session-id")).not.toBe(id1);
    expect((await post(token, "ping")).headers.get("mcp-session-id")).toBeNull();
  });

  test("two sessions on the same token select different workspaces without interfering", async () => {
    const { token } = createToken(tokenName("sessions"), "write");
    await call(token, "brain_use_workspace", { id: B.id }, "session-one");
    // session-two never selected anything, so it is on the default — NOT on session-one's choice
    const two = await call(token, "brain_list", {}, "session-two");
    expect(text(two)).toContain("only-in-alpha.md");
    expect(blocks(two)).toHaveLength(2); // and it is told it fell through to the default
    expect(text(await call(token, "brain_list", {}, "session-one"))).toContain("only-in-beta.md");

    await call(token, "brain_use_workspace", { id: A.id }, "session-two");
    expect(text(await call(token, "brain_list", {}, "session-one"))).toContain("only-in-beta.md");
    expect(text(await call(token, "brain_list", {}, "session-two"))).toContain("only-in-alpha.md");
  });

  test("a client that sends no session id keeps the old behaviour: one selection per credential", async () => {
    const { token } = createToken(tokenName("nosession"), "write");
    await call(token, "brain_use_workspace", { id: B.id });
    expect(text(await call(token, "brain_list"))).toContain("only-in-beta.md");
    // a session-aware chat on the same token is separate from that shared selection
    expect(text(await call(token, "brain_list", {}, "some-session"))).toContain("only-in-alpha.md");
  });

  test("a read in one session does not authorise an edit in another", async () => {
    const { token } = createToken(tokenName("session-reads"), "write");
    await call(token, "brain_read", { path: "shared.md", workspace: A.id }, "reader");

    const other = await call(
      token,
      "brain_write",
      { path: "shared.md", content: "# Shared\n\nfrom the other session\n", workspace: A.id },
      "other",
    );
    expect(other.result?.isError).toBe(true);
    expect(text(other)).toContain("have not read it");

    const reader = await call(
      token,
      "brain_write",
      { path: "shared.md", content: "# Shared\n\nfrom the reading session\n", workspace: A.id },
      "reader",
    );
    expect(reader.result?.isError).toBeFalsy();
  });

  test("an unknown or malformed session id is harmless: it just has empty state", async () => {
    const { token } = createToken(tokenName("badsession"), "write");
    expect(text(await call(token, "brain_list", {}, "never-issued"))).toContain("only-in-alpha.md");
    expect(text(await call(token, "brain_list", {}, "has a space"))).toContain("only-in-alpha.md"); // ignored
    expect(text(await call(token, "brain_list", {}, "x".repeat(500)))).toContain("only-in-alpha.md"); // ignored
  });
});

describe("read-before-edit is scoped to the workspace it happened in", () => {
  test("reading shared.md in one vault does not authorise overwriting shared.md in another", async () => {
    const { token } = createToken(tokenName("reads"), "write");

    await call(token, "brain_read", { path: "shared.md", workspace: A.id });

    const wrongVault = await call(token, "brain_write", {
      path: "shared.md",
      content: "# Shared\n\nclobbered\n",
      workspace: B.id,
    });
    expect(wrongVault.result?.isError).toBe(true);
    expect(text(wrongVault)).toContain("have not read it");
    expect(fs.readFileSync(path.join(DATA, "vaults", B.id, "shared.md"), "utf8")).toContain("original text in Iso Beta");

    // ...while the vault it did read is writable.
    const rightVault = await call(token, "brain_write", {
      path: "shared.md",
      content: "# Shared\n\nupdated after reading, in Alpha only\n",
      workspace: A.id,
    });
    expect(rightVault.result?.isError).toBeFalsy();
  });
});
