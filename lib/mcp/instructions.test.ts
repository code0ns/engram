import { describe, expect, test } from "bun:test";
import { serverInstructions } from "./instructions";
import { TOOLS, visibleTools } from "./tools";

const namesIn = (text: string) => [...new Set(text.match(/\b(?:brain|tool|skill)_[a-z_]+\b/g) ?? [])];
const visible = (canWrite: boolean, harnessOn: boolean, tregOn: boolean) =>
  visibleTools(canWrite, harnessOn, tregOn).map((t) => t.name);

describe("serverInstructions", () => {
  test("never names a tool the caller cannot see, for any scope / Treg / harness combination", () => {
    for (const canWrite of [false, true]) {
      for (const tregOn of [false, true]) {
        for (const harnessOn of [false, true]) {
          const names = visible(canWrite, harnessOn, tregOn);
          for (const mentioned of namesIn(serverInstructions(names))) {
            expect({ canWrite, tregOn, harnessOn, mentioned, listed: names.includes(mentioned) }).toMatchObject({ listed: true });
          }
        }
      }
    }
  });

  test("tells every caller to read the schema and search before answering", () => {
    const text = serverInstructions(visible(false, false, false));
    expect(text).toContain("brain_schema");
    expect(text).toContain("brain_search");
    expect(text).toContain("tool_search");
  });

  test("a read-only token is never told to save", () => {
    const text = serverInstructions(visible(false, true, true));
    expect(text).not.toMatch(/Save as you go/);
    expect(namesIn(text)).not.toContain("brain_write");
    expect(namesIn(text)).not.toContain("tool_recipe_save");
  });

  test("a write token is told to save decisions and to supersede changed facts", () => {
    const text = serverInstructions(visible(true, false, false));
    expect(text).toMatch(/Save as you go/);
    expect(text).toContain("brain_supersede");
    expect(text).toContain("tool_recipe_save");
  });

  test("the paid tools are mentioned only when the workspace has Treg", () => {
    expect(serverInstructions(visible(true, false, false))).not.toContain("tool_call");
    expect(serverInstructions(visible(true, false, true))).toMatch(/tool_call spends this workspace's money/);
  });

  test("the stdio server (brain_* tools only) gets no recipe or skill advice", () => {
    const text = serverInstructions(TOOLS.map((t) => t.name));
    expect(text).not.toContain("tool_search");
    expect(text).not.toContain("skill_lint");
    expect(text).toMatch(/Save as you go/);
  });

  test("stays short — clients load it on every connection", () => {
    expect(serverInstructions(visible(true, true, true)).length).toBeLessThan(2000);
  });
});
