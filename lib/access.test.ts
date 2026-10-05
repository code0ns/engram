import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { adminEmails, allGrants, grantsForEmail, isAdmin, removeGrants, setAdmin, setGrantsForEmail } from "./access";

// ALLOWED_EMAILS is pinned in test/setup.ts; the first address is the bootstrap owner.
const OWNER = "owner@test.dev";
const COLLEAGUE = "colleague@test.dev";
const OTHER = "other@test.dev";

const DATA = process.env.ENGRAM_DATA_DIR!;
const ACCESS_FILE = path.join(DATA, "access.json");
const REPOS_FILE = path.join(DATA, "repos.json");

function repo(id: string) {
  return { id, name: id, url: `https://example.com/${id}.git`, branch: "main", active: false, addedAt: "2026-01-01" };
}
const setRepos = (...ids: string[]) => {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(REPOS_FILE, JSON.stringify(ids.map(repo)));
};
const accessOnDisk = () => JSON.parse(fs.readFileSync(ACCESS_FILE, "utf8")) as { email: string; workspaceIds: string[]; isAdmin?: boolean }[];

beforeEach(() => {
  fs.rmSync(ACCESS_FILE, { force: true });
  setRepos("ws-a", "ws-b");
});

describe("grant migration", () => {
  test("an allowed email with no record still gets every existing workspace, once", () => {
    expect(grantsForEmail(COLLEAGUE).sort()).toEqual(["ws-a", "ws-b"]);
  });

  test("an email that is not allowed gets nothing", () => {
    expect(grantsForEmail("stranger@test.dev")).toEqual([]);
  });
});

describe("removing a person", () => {
  test("does not re-grant everything on their next request (the old tombstone bug)", () => {
    setGrantsForEmail(COLLEAGUE, ["ws-a"]);
    removeGrants(COLLEAGUE);
    expect(grantsForEmail(COLLEAGUE)).toEqual([]);
    // ...and it stays empty: reading it must not have re-run the migration.
    expect(grantsForEmail(COLLEAGUE)).toEqual([]);
  });

  test("blocks the migration even for an allowed email that never had a record", () => {
    removeGrants(OTHER);
    expect(grantsForEmail(OTHER)).toEqual([]);
  });

  test("a removed person shows up as an empty record, not as a missing one", () => {
    setGrantsForEmail(COLLEAGUE, ["ws-a"]);
    removeGrants(COLLEAGUE);
    const row = allGrants().find((g) => g.email === COLLEAGUE);
    expect(row?.workspaceIds).toEqual([]);
  });

  test("a removed admin is no longer an admin", () => {
    setAdmin(COLLEAGUE, true);
    removeGrants(COLLEAGUE);
    expect(isAdmin(COLLEAGUE)).toBe(false);
  });
});

describe("admins", () => {
  test("before any flag exists, the first allowed email is the owner/admin", () => {
    expect(adminEmails()).toEqual([OWNER]);
    expect(isAdmin(OWNER)).toBe(true);
    expect(isAdmin(COLLEAGUE)).toBe(false);
  });

  test("admin check ignores email case", () => {
    expect(isAdmin("OWNER@TEST.DEV")).toBe(true);
  });

  test("the bootstrap owner is written down as an explicit flag once workspaces exist", () => {
    allGrants(); // the People tab loads this
    const owner = accessOnDisk().find((g) => g.email === OWNER);
    expect(owner?.isAdmin).toBe(true);
    expect(owner?.workspaceIds.sort()).toEqual(["ws-a", "ws-b"]);
  });

  test("on a fresh deploy with no workspaces it does NOT freeze an empty owner record", () => {
    setRepos(); // nothing connected yet
    expect(isAdmin(OWNER)).toBe(true); // still usable: they must be able to add the first workspace
    allGrants();
    expect(fs.existsSync(ACCESS_FILE)).toBe(false);

    setRepos("ws-a");
    expect(grantsForEmail(OWNER)).toEqual(["ws-a"]); // the one-time migration still fires
  });

  test("promoting someone keeps the owner an admin", () => {
    setAdmin(COLLEAGUE, true);
    expect(adminEmails().sort()).toEqual([COLLEAGUE, OWNER]);
  });

  test("the last admin cannot be demoted or removed", () => {
    expect(() => setAdmin(OWNER, false)).toThrow(/at least one admin/i);
    expect(() => removeGrants(OWNER)).toThrow(/at least one admin/i);
    expect(isAdmin(OWNER)).toBe(true);
  });

  test("once someone else is an admin, the owner can step down", () => {
    setAdmin(COLLEAGUE, true);
    setAdmin(OWNER, false);
    expect(adminEmails()).toEqual([COLLEAGUE]);
  });

  test("changing someone's workspaces does not touch their admin flag", () => {
    setAdmin(COLLEAGUE, true);
    setGrantsForEmail(COLLEAGUE, ["ws-b"]);
    expect(isAdmin(COLLEAGUE)).toBe(true);
    expect(grantsForEmail(COLLEAGUE)).toEqual(["ws-b"]);
  });

  test("allGrants reports the effective admin flag on every row", () => {
    setGrantsForEmail(COLLEAGUE, ["ws-a"]);
    const rows = allGrants();
    expect(rows.find((g) => g.email === OWNER)?.isAdmin).toBe(true);
    expect(rows.find((g) => g.email === COLLEAGUE)?.isAdmin).toBe(false);
  });
});
