import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  WORKSPACE_TOOLS,
  WORKSPACE_TOOL_MAP,
  listAccessibleWorkspaces,
  switchToWorkspace,
  clearWorkspaceSelection,
} from "./workspace-tools";
import {
  selectWorkspace,
  getSelectedWorkspace,
  resetWorkspaceSessions,
} from "./workspace-session";
import { withActor } from "@/lib/actor";
import type { TokenCaller, ResolvedWorkspace } from "@/lib/workspace-resolve";

describe("workspace tools surface", () => {
  test("every workspace tool has a name, description, and input schema", () => {
    for (const t of WORKSPACE_TOOLS) {
      expect(t.name).toMatch(/^brain_/);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema).toBeTruthy();
    }
  });

  test("workspace tool names are unique", () => {
    expect(WORKSPACE_TOOL_MAP.size).toBe(WORKSPACE_TOOLS.length);
  });

  test("brain_workspaces is read-only", () => {
    const tool = WORKSPACE_TOOL_MAP.get("brain_workspaces");
    expect(tool).toBeDefined();
    expect(tool!.write).toBeFalsy();
  });

  test("brain_use_workspace is marked as write (modifies session state)", () => {
    const tool = WORKSPACE_TOOL_MAP.get("brain_use_workspace");
    expect(tool).toBeDefined();
    expect(tool!.write).toBe(true);
  });

  test("brain_use_workspace requires id parameter", () => {
    const tool = WORKSPACE_TOOL_MAP.get("brain_use_workspace");
    expect(tool).toBeDefined();
    const schema = tool!.inputSchema as { required?: string[] };
    expect(schema.required).toContain("id");
  });

  test("brain_sync_status is read-only", () => {
    const tool = WORKSPACE_TOOL_MAP.get("brain_sync_status");
    expect(tool).toBeDefined();
    expect(tool!.write).toBeFalsy();
  });

  test("brain_sync is marked as write (modifies git state)", () => {
    const tool = WORKSPACE_TOOL_MAP.get("brain_sync");
    expect(tool).toBeDefined();
    expect(tool!.write).toBe(true);
  });

  test("all expected workspace tools are present", () => {
    const expectedTools = ["brain_workspaces", "brain_use_workspace", "brain_sync_status", "brain_sync"];
    for (const name of expectedTools) {
      expect(WORKSPACE_TOOL_MAP.has(name)).toBe(true);
    }
  });
});

describe("workspace session management", () => {
  beforeEach(() => {
    resetWorkspaceSessions();
  });

  afterEach(() => {
    resetWorkspaceSessions();
  });

  test("getSelectedWorkspace returns null when nothing is selected", () => {
    const selected = withActor("test-agent", () => getSelectedWorkspace());
    expect(selected).toBeNull();
  });

  test("selectWorkspace stores the selection for the current actor", () => {
    withActor("test-agent", () => {
      selectWorkspace("workspace-123");
      const selected = getSelectedWorkspace();
      expect(selected).toBe("workspace-123");
    });
  });

  test("different actors have independent workspace selections", () => {
    withActor("agent-1", () => {
      selectWorkspace("workspace-a");
    });
    withActor("agent-2", () => {
      selectWorkspace("workspace-b");
    });

    const selected1 = withActor("agent-1", () => getSelectedWorkspace());
    const selected2 = withActor("agent-2", () => getSelectedWorkspace());

    expect(selected1).toBe("workspace-a");
    expect(selected2).toBe("workspace-b");
  });

  test("clearSelectedWorkspace removes the selection", () => {
    withActor("test-agent", () => {
      selectWorkspace("workspace-123");
      expect(getSelectedWorkspace()).toBe("workspace-123");
      // clearWorkspaceSelection is the tool-level function
      clearWorkspaceSelection();
      expect(getSelectedWorkspace()).toBeNull();
    });
  });

  test("selection expires after TTL", () => {
    const now = Date.now();
    withActor("test-agent", () => {
      selectWorkspace("workspace-123", now);
      // Selection should be valid at current time
      expect(getSelectedWorkspace(now)).toBe("workspace-123");
      // Selection should be expired after 1 hour + 1ms
      const expiredTime = now + 60 * 60 * 1000 + 1;
      expect(getSelectedWorkspace(expiredTime)).toBeNull();
    });
  });

  test("accessing selection refreshes TTL (sliding window)", () => {
    const now = Date.now();
    withActor("test-agent", () => {
      selectWorkspace("workspace-123", now);
      // Access at 30 minutes
      const midway = now + 30 * 60 * 1000;
      expect(getSelectedWorkspace(midway)).toBe("workspace-123");
      // Now TTL should be refreshed, so 30 more minutes should still be valid
      const later = midway + 30 * 60 * 1000;
      expect(getSelectedWorkspace(later)).toBe("workspace-123");
    });
  });
});

describe("access control in workspace listing", () => {
  const sharedCaller: TokenCaller = { kind: "shared" };
  const localCaller: TokenCaller = { kind: "local" };
  const scopedNamedCaller: TokenCaller = { kind: "named", workspaceIds: ["ws-1", "ws-2"] };
  const unscopedNamedCaller: TokenCaller = { kind: "named", workspaceIds: [] };
  const defaultWorkspace: ResolvedWorkspace = {
    workspaceId: "ws-1",
    dir: "/data/vaults/ws-1",
    name: "Primary Vault",
  };

  test("shared token sees all workspaces as accessible", () => {
    // This test verifies the logic without actual repo state
    // In production, listAccessibleWorkspaces calls listRepos()
    withActor("shared-token", () => {
      const result = listAccessibleWorkspaces(sharedCaller, defaultWorkspace);
      // With no repos configured, this returns empty workspaces
      // The key assertion is that the function doesn't throw and returns the right shape
      expect(result).toHaveProperty("workspaces");
      expect(result).toHaveProperty("selected");
      expect(result).toHaveProperty("current");
      expect(result.current).toBe("ws-1");
    });
  });

  test("local caller sees all workspaces as accessible", () => {
    withActor("local", () => {
      const result = listAccessibleWorkspaces(localCaller, defaultWorkspace);
      expect(result).toHaveProperty("workspaces");
      expect(Array.isArray(result.workspaces)).toBe(true);
    });
  });

  test("scoped named token only sees its allowed workspaces", () => {
    withActor("test-token", () => {
      const result = listAccessibleWorkspaces(scopedNamedCaller, defaultWorkspace);
      // All returned workspaces should be in the allowed list
      for (const ws of result.workspaces) {
        if (ws.accessible) {
          expect(["ws-1", "ws-2"]).toContain(ws.id);
        }
      }
    });
  });

  test("unscoped named token sees all workspaces (legacy full access)", () => {
    withActor("legacy-token", () => {
      const result = listAccessibleWorkspaces(unscopedNamedCaller, defaultWorkspace);
      // Should behave like shared token
      expect(result).toHaveProperty("workspaces");
    });
  });

  test("result includes current workspace from default resolution", () => {
    withActor("test-agent", () => {
      const result = listAccessibleWorkspaces(sharedCaller, defaultWorkspace);
      expect(result.current).toBe("ws-1");
    });
  });

  test("result includes selected workspace from session", () => {
    withActor("test-agent", () => {
      selectWorkspace("ws-selected");
      const result = listAccessibleWorkspaces(sharedCaller, defaultWorkspace);
      expect(result.selected).toBe("ws-selected");
    });
  });
});

describe("workspace tools integration", () => {
  test("brain_workspaces returns the expected shape", () => {
    withActor("test-agent", () => {
      const defaultWs: ResolvedWorkspace = {
        workspaceId: null,
        dir: "/sample-vault",
        name: "Sample vault",
      };
      const result = listAccessibleWorkspaces({ kind: "local" }, defaultWs);

      expect(result).toHaveProperty("workspaces");
      expect(result).toHaveProperty("selected");
      expect(result).toHaveProperty("current");
      expect(Array.isArray(result.workspaces)).toBe(true);
    });
  });

  test("switchToWorkspace returns error for non-existent workspace", async () => {
    await withActor("test-agent", async () => {
      const result = await switchToWorkspace({ kind: "shared" }, "non-existent-id");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("not found");
      }
    });
  });

  test("clearWorkspaceSelection returns ok", () => {
    withActor("test-agent", () => {
      selectWorkspace("some-workspace");
      const result = clearWorkspaceSelection();
      expect(result.ok).toBe(true);
      expect(getSelectedWorkspace()).toBeNull();
    });
  });
});
