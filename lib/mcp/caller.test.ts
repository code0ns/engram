import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { withActor } from "@/lib/actor";
import type { TokenCaller } from "@/lib/workspace-resolve";
import {
  NO_WORKSPACE_ARG,
  WorkspaceArgError,
  contentWithNotice,
  matchWorkspaceArg,
  oauthActor,
  refuseWrite,
  resolveEffective,
  splitWorkspaceArg,
  withWorkspaceArg,
  workspaceNotice,
} from "./caller";
import { WORKSPACE_TOOLS } from "./workspace-tools";
import { TOOLS, visibleTools } from "./tools";
import { getSelectedWorkspace, resetWorkspaceSessions, selectWorkspace } from "./workspace-session";

const DATA = process.env.ENGRAM_DATA_DIR!;

function repo(id: string, name: string, active = false) {
  return { id, name, url: `https://example.com/${id}.git`, branch: "main", active, addedAt: "2026-01-01" };
}

/** Alpha is the global default; the two Gamma-named repos exist to prove name ambiguity is an error. */
beforeEach(() => {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(
    path.join(DATA, "repos.json"),
    JSON.stringify([repo("ws-a", "Alpha", true), repo("ws-b", "Beta"), repo("ws-g1", "Gamma"), repo("ws-g2", "Gamma")]),
  );
  resetWorkspaceSessions();
});

afterEach(() => {
  delete process.env.MCP_REQUIRE_WORKSPACE_FOR_WRITES;
});

const operator: TokenCaller = { kind: "shared" }; // full access
const pinnedToA: TokenCaller = { kind: "named", workspaceIds: ["ws-a"] };
const pinnedToAB: TokenCaller = { kind: "named", workspaceIds: ["ws-a", "ws-b"] };

describe("matchWorkspaceArg", () => {
  test("matches by id", () => {
    expect(matchWorkspaceArg(operator, "ws-b").name).toBe("Beta");
  });

  test("matches by exact name, ignoring surrounding whitespace", () => {
    expect(matchWorkspaceArg(operator, "  Beta ").id).toBe("ws-b");
  });

  test("a name is exact: no case folding or partial match", () => {
    expect(() => matchWorkspaceArg(operator, "beta")).toThrow(WorkspaceArgError);
    expect(() => matchWorkspaceArg(operator, "Bet")).toThrow(WorkspaceArgError);
  });

  test("two workspaces with the same name are an error that points at the ids", () => {
    expect(() => matchWorkspaceArg(operator, "Gamma")).toThrow(/ws-g1.*ws-g2|ws-g2.*ws-g1/);
    expect(matchWorkspaceArg(operator, "ws-g2").id).toBe("ws-g2"); // the id disambiguates
  });

  test("only your own workspaces can be matched, and the error lists only those", () => {
    let message = "";
    try {
      matchWorkspaceArg(pinnedToA, "Beta");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/No workspace "Beta" is available/);
    expect(message).toContain("Alpha");
    // A customer must not learn another customer's vault names from the error text.
    for (const hidden of ["ws-b", "ws-g1", "Gamma"]) expect(message).not.toContain(hidden);
  });

  test("a workspace that exists but isn't yours gives the same error as one that doesn't exist", () => {
    const msg = (arg: string) => {
      try {
        matchWorkspaceArg(pinnedToA, arg);
      } catch (e) {
        return (e as Error).message.replace(arg, "<arg>");
      }
      return "";
    };
    expect(msg("Beta")).toBe(msg("Nonexistent"));
  });

  test("a non-string or blank argument is rejected", () => {
    for (const bad of [123, true, {}, [], "", "   "]) {
      expect(() => matchWorkspaceArg(operator, bad)).toThrow(/non-empty string/);
    }
  });
});

describe("resolveEffective", () => {
  test("an argument wins over a selection", () => {
    withActor("t-arg", () => {
      selectWorkspace("ws-b");
      const eff = resolveEffective(operator, "Alpha")!;
      expect(eff.source).toBe("argument");
      expect(eff.ws.workspaceId).toBe("ws-a");
    });
  });

  test("the argument is per call: it does not change the selection", () => {
    withActor("t-arg2", () => {
      selectWorkspace("ws-b");
      resolveEffective(operator, "Alpha");
      expect(getSelectedWorkspace()).toBe("ws-b");
      expect(resolveEffective(operator)!.ws.workspaceId).toBe("ws-b");
    });
  });

  test("with no argument, the selection is used", () => {
    withActor("t-sel", () => {
      selectWorkspace("ws-b");
      const eff = resolveEffective(operator)!;
      expect(eff.source).toBe("selection");
      expect(eff.ws.workspaceId).toBe("ws-b");
    });
  });

  test("with neither, it falls back to the default", () => {
    withActor("t-def", () => {
      const eff = resolveEffective(operator)!;
      expect(eff.source).toBe("default");
      expect(eff.ws.workspaceId).toBe("ws-a");
    });
  });

  test("a selection the credential can no longer use falls through to the default", () => {
    withActor("t-lost", () => {
      selectWorkspace("ws-b"); // chosen while it had access...
      const eff = resolveEffective(pinnedToA)!; // ...but this credential is pinned to A only
      expect(eff.source).toBe("default");
      expect(eff.ws.workspaceId).toBe("ws-a");
    });
  });

  test("a bad argument throws and never degrades into the default", () => {
    withActor("t-bad", () => {
      expect(() => resolveEffective(pinnedToA, "Beta")).toThrow(WorkspaceArgError);
    });
  });

  test("null is treated as not given", () => {
    withActor("t-null", () => {
      expect(resolveEffective(operator, null)!.source).toBe("default");
    });
  });

  test("reports how many workspaces the credential can reach", () => {
    withActor("t-reach", () => {
      expect(resolveEffective(operator)!.reachable).toBe(4);
      expect(resolveEffective(pinnedToAB)!.reachable).toBe(2);
      expect(resolveEffective(pinnedToA)!.reachable).toBe(1);
    });
  });

  test("selections are per actor: two OAuth users do not share one", () => {
    const alice = oauthActor("alice@x.test");
    const bob = oauthActor("bob@x.test");
    expect(alice).not.toBe(bob);
    withActor(alice, () => selectWorkspace("ws-a"));
    withActor(bob, () => selectWorkspace("ws-b"));
    expect(withActor(alice, () => getSelectedWorkspace())).toBe("ws-a");
    expect(withActor(bob, () => getSelectedWorkspace())).toBe("ws-b");
  });
});

describe("workspaceNotice", () => {
  test("warns when a multi-workspace credential falls through to the default, naming it", () => {
    withActor("n1", () => {
      const note = workspaceNotice(resolveEffective(operator)!)!;
      expect(note).toContain('"Alpha"');
      expect(note).toContain("4 workspaces");
      expect(note).toContain("`workspace`");
    });
  });

  test("says nothing when the call named its workspace or has a selection", () => {
    withActor("n2", () => {
      expect(workspaceNotice(resolveEffective(operator, "Beta")!)).toBeNull();
      selectWorkspace("ws-b");
      expect(workspaceNotice(resolveEffective(operator)!)).toBeNull();
    });
  });

  test("says nothing to a credential pinned to one workspace: there is nothing to confuse", () => {
    withActor("n3", () => {
      expect(workspaceNotice(resolveEffective(pinnedToA)!)).toBeNull();
    });
  });
});

describe("refuseWrite (MCP_REQUIRE_WORKSPACE_FOR_WRITES)", () => {
  test("is off unless the operator turns it on", () => {
    withActor("r1", () => {
      expect(refuseWrite("brain_write", resolveEffective(operator)!)).toBeNull();
    });
  });

  test("when on, refuses a write that would land in the default by guesswork", () => {
    process.env.MCP_REQUIRE_WORKSPACE_FOR_WRITES = "true";
    withActor("r2", () => {
      const msg = refuseWrite("brain_write", resolveEffective(operator)!)!;
      expect(msg).toContain("brain_write was not run");
      expect(msg).toContain("Nothing was written");
    });
  });

  test("when on, still allows writes that named a workspace or have a selection", () => {
    process.env.MCP_REQUIRE_WORKSPACE_FOR_WRITES = "true";
    withActor("r3", () => {
      expect(refuseWrite("brain_write", resolveEffective(operator, "Beta")!)).toBeNull();
      selectWorkspace("ws-b");
      expect(refuseWrite("brain_write", resolveEffective(operator)!)).toBeNull();
    });
  });

  test("when on, never blocks a credential pinned to one workspace", () => {
    process.env.MCP_REQUIRE_WORKSPACE_FOR_WRITES = "true";
    withActor("r4", () => {
      expect(refuseWrite("brain_write", resolveEffective(pinnedToA)!)).toBeNull();
    });
  });
});

describe("the workspace argument on the wire", () => {
  test("splitWorkspaceArg removes only `workspace`", () => {
    expect(splitWorkspaceArg({ path: "a.md", workspace: "Beta" })).toEqual({ workspace: "Beta", args: { path: "a.md" } });
    expect(splitWorkspaceArg({ path: "a.md" })).toEqual({ workspace: undefined, args: { path: "a.md" } });
  });

  test("non-object arguments pass through so the tool's own validation reports them", () => {
    expect(splitWorkspaceArg("oops")).toEqual({ workspace: undefined, args: "oops" });
    expect(splitWorkspaceArg(null)).toEqual({ workspace: undefined, args: null });
    expect(splitWorkspaceArg([1])).toEqual({ workspace: undefined, args: [1] });
  });

  test("withWorkspaceArg adds an optional string property without mutating the tool's schema", () => {
    const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
    const out = withWorkspaceArg(schema) as { properties: Record<string, { type?: string }>; required: string[] };
    expect(out.properties.workspace.type).toBe("string");
    expect(out.properties.path.type).toBe("string");
    expect(out.required).toEqual(["path"]); // never required
    expect(schema.properties).not.toHaveProperty("workspace");
  });

  test("no tool defines its own `workspace` parameter (it would be silently stripped)", () => {
    const all = [...TOOLS, ...visibleTools(true, true, true), ...WORKSPACE_TOOLS];
    for (const t of all) {
      const props = (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect({ tool: t.name, hasWorkspaceProp: "workspace" in props }).toEqual({ tool: t.name, hasWorkspaceProp: false });
    }
  });

  test("the selection tools are the only ones that take no per-call workspace", () => {
    expect([...NO_WORKSPACE_ARG].sort()).toEqual(["brain_use_workspace", "brain_workspaces"]);
  });

  test("the notice rides in a second content block, leaving the first parseable", () => {
    const blocks = contentWithNotice('{"ok":true}', "Notice: x");
    expect(blocks).toHaveLength(2);
    expect(JSON.parse(blocks[0].text)).toEqual({ ok: true });
    expect(contentWithNotice("{}", null)).toHaveLength(1);
  });
});
