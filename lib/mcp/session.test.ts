import { beforeEach, describe, expect, test } from "bun:test";
import { withActor } from "@/lib/actor";
import { hasRead, recordRead, resetSessions } from "./session";

const DIR_A = "/data/vaults/a";
const DIR_B = "/data/vaults/b";

beforeEach(() => resetSessions());

describe("read-before-edit tracking", () => {
  test("a read counts for that note in that workspace", () => {
    withActor("agent", () => {
      recordRead(DIR_A, "notes/x.md");
      expect(hasRead(DIR_A, "notes/x.md")).toBe(true);
    });
  });

  test("the same relative path in another workspace is a different note", () => {
    withActor("agent", () => {
      recordRead(DIR_A, "README.md");
      expect(hasRead(DIR_B, "README.md")).toBe(false);
    });
  });

  test("reads are per actor: one agent's read does not authorise another's edit", () => {
    withActor("agent-1", () => recordRead(DIR_A, "x.md"));
    expect(withActor("agent-2", () => hasRead(DIR_A, "x.md"))).toBe(false);
    expect(withActor("agent-1", () => hasRead(DIR_A, "x.md"))).toBe(true);
  });

  test("a read expires after the window", () => {
    withActor("agent", () => {
      const t0 = 1_000_000;
      recordRead(DIR_A, "x.md", t0);
      expect(hasRead(DIR_A, "x.md", t0 + 29 * 60_000)).toBe(true);
      expect(hasRead(DIR_A, "x.md", t0 + 31 * 60_000)).toBe(false);
    });
  });

  test("reads are per MCP session: a read in one chat does not authorise another chat on the same credential", () => {
    withActor("agent", () => recordRead(DIR_A, "x.md"), "chat-1");
    expect(withActor("agent", () => hasRead(DIR_A, "x.md"), "chat-1")).toBe(true);
    expect(withActor("agent", () => hasRead(DIR_A, "x.md"), "chat-2")).toBe(false);
    expect(withActor("agent", () => hasRead(DIR_A, "x.md"))).toBe(false); // nor the session-less bucket
  });

  test("an actor name can never collide with another actor's (actor, session) pair", () => {
    withActor('agent","chat-1', () => recordRead(DIR_A, "x.md"));
    expect(withActor("agent", () => hasRead(DIR_A, "x.md"), "chat-1")).toBe(false);
  });

  test("an empty path is never recorded", () => {
    withActor("agent", () => {
      recordRead(DIR_A, "");
      expect(hasRead(DIR_A, "")).toBe(false);
    });
  });
});
