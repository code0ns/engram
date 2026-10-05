import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createSessionToken } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/config";
import { grantsForEmail, isAdmin, setAdmin, setGrantsForEmail } from "@/lib/access";
import { listRepos } from "@/lib/repos";
import { GET as accessGet, POST as accessPost, DELETE as accessDelete } from "@/app/api/access/route";
import { POST as reposPost } from "@/app/api/repos/route";
import { PATCH as repoPatch, PUT as repoPut, DELETE as repoDelete } from "@/app/api/repos/[id]/route";
import { GET as tregGet, PUT as tregPut } from "@/app/api/repos/[id]/treg/route";

/**
 * The admin boundary, exercised through the real route handlers with real signed session cookies.
 * ALLOWED_EMAILS / AUTH_SECRET are pinned in test/setup.ts; the first allowed address is the owner.
 */

const OWNER = "owner@test.dev";
const MEMBER = "colleague@test.dev";
const STRANGER = "stranger@test.dev"; // not on ALLOWED_EMAILS

const DATA = process.env.ENGRAM_DATA_DIR!;
const rm = (f: string) => fs.rmSync(path.join(DATA, f), { force: true });

function repo(id: string) {
  return { id, name: `Name of ${id}`, url: `https://example.com/${id}.git`, branch: "main", active: false, addedAt: "2026-01-01" };
}

beforeEach(() => {
  for (const f of ["access.json", "treg.json", "treg-ledger.json"]) rm(f);
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, "repos.json"), JSON.stringify([repo("ws-a"), repo("ws-b")]));
  // The owner is admin with everything; the member has ws-a only.
  setGrantsForEmail(OWNER, ["ws-a", "ws-b"]);
  setGrantsForEmail(MEMBER, ["ws-a"]);
});

async function request(method: string, url: string, as?: string, body?: unknown): Promise<Request> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (as) headers.cookie = `${SESSION_COOKIE}=${await createSessionToken({ email: as })}`;
  return new Request(`http://localhost${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe("/api/access", () => {
  test("no session is rejected", async () => {
    const res = await accessPost(await request("POST", "/api/access", undefined, { email: MEMBER, workspaceIds: [] }));
    expect(res.status).toBe(401);
  });

  test("a member cannot grant themselves another workspace", async () => {
    const res = await accessPost(await request("POST", "/api/access", MEMBER, { email: MEMBER, workspaceIds: ["ws-a", "ws-b"] }));
    expect(res.status).toBe(403);
    expect(grantsForEmail(MEMBER)).toEqual(["ws-a"]);
  });

  test("a member cannot make themselves admin", async () => {
    const res = await accessPost(await request("POST", "/api/access", MEMBER, { email: MEMBER, isAdmin: true }));
    expect(res.status).toBe(403);
    expect(isAdmin(MEMBER)).toBe(false);
  });

  test("a member cannot revoke anyone", async () => {
    const res = await accessDelete(await request("DELETE", `/api/access?email=${OWNER}`, MEMBER));
    expect(res.status).toBe(403);
    expect(grantsForEmail(OWNER).sort()).toEqual(["ws-a", "ws-b"]);
  });

  test("an admin can grant, and the change takes effect", async () => {
    const res = await accessPost(await request("POST", "/api/access", OWNER, { email: MEMBER, workspaceIds: ["ws-a", "ws-b"] }));
    expect(res.status).toBe(200);
    expect(grantsForEmail(MEMBER).sort()).toEqual(["ws-a", "ws-b"]);
  });

  test("a promoted admin can then manage access", async () => {
    await accessPost(await request("POST", "/api/access", OWNER, { email: MEMBER, isAdmin: true }));
    const res = await accessPost(await request("POST", "/api/access", MEMBER, { email: "other@test.dev", workspaceIds: ["ws-b"] }));
    expect(res.status).toBe(200);
    expect(grantsForEmail("other@test.dev")).toEqual(["ws-b"]);
  });

  test("the last admin cannot be removed or demoted through the API", async () => {
    const del = await accessDelete(await request("DELETE", `/api/access?email=${OWNER}`, OWNER));
    expect(del.status).toBe(400);
    const demote = await accessPost(await request("POST", "/api/access", OWNER, { email: OWNER, isAdmin: false }));
    expect(demote.status).toBe(400);
    expect(isAdmin(OWNER)).toBe(true);
  });

  test("revoking a member really leaves them with nothing (no re-grant on their next request)", async () => {
    const del = await accessDelete(await request("DELETE", `/api/access?email=${MEMBER}`, OWNER));
    expect(del.status).toBe(200);
    expect(grantsForEmail(MEMBER)).toEqual([]);
  });

  test("an email off the allowlist cannot be granted", async () => {
    const res = await accessPost(await request("POST", "/api/access", OWNER, { email: STRANGER, workspaceIds: ["ws-a"] }));
    expect(res.status).toBe(400);
  });

  test("a body with neither workspaceIds nor isAdmin is rejected", async () => {
    const res = await accessPost(await request("POST", "/api/access", OWNER, { email: MEMBER }));
    expect(res.status).toBe(400);
  });

  test("an admin sees everyone and every workspace", async () => {
    const res = await accessGet(await request("GET", "/api/access", OWNER));
    const body = await res.json();
    expect(body.me).toEqual({ email: OWNER, isAdmin: true });
    expect(body.grants.map((g: { email: string }) => g.email).sort()).toEqual([MEMBER, OWNER]);
    expect(body.repos.map((r: { id: string }) => r.id).sort()).toEqual(["ws-a", "ws-b"]);
  });

  test("a member sees only their own row and their own workspaces — not other clients' names", async () => {
    const res = await accessGet(await request("GET", "/api/access", MEMBER));
    const body = await res.json();
    expect(body.me).toEqual({ email: MEMBER, isAdmin: false });
    expect(body.grants.map((g: { email: string }) => g.email)).toEqual([MEMBER]);
    expect(body.repos.map((r: { id: string }) => r.id)).toEqual(["ws-a"]);
    expect(JSON.stringify(body)).not.toContain("ws-b");
    expect(body.allowedEmails).toEqual([]);
  });
});

describe("/api/repos (workspace management)", () => {
  test("a member cannot add a workspace", async () => {
    const res = await reposPost(await request("POST", "/api/repos", MEMBER, { url: "https://example.com/x.git" }));
    expect(res.status).toBe(403);
  });

  test("a member cannot rename, re-token or delete a workspace they are granted on", async () => {
    const patch = await repoPatch(await request("PATCH", "/api/repos/ws-a", MEMBER, { name: "Hijacked" }), idParams("ws-a"));
    expect(patch.status).toBe(403);
    const put = await repoPut(await request("PUT", "/api/repos/ws-a", MEMBER, { token: "ghp_x" }), idParams("ws-a"));
    expect(put.status).toBe(403);
    const del = await repoDelete(await request("DELETE", "/api/repos/ws-a", MEMBER), idParams("ws-a"));
    expect(del.status).toBe(403);
    expect(listRepos().find((r) => r.id === "ws-a")?.name).toBe("Name of ws-a");
  });

  test("an admin can rename", async () => {
    const res = await repoPatch(await request("PATCH", "/api/repos/ws-a", OWNER, { name: "Renamed" }), idParams("ws-a"));
    expect(res.status).toBe(200);
    expect(listRepos().find((r) => r.id === "ws-a")?.name).toBe("Renamed");
  });

  test("an admin who is not granted a workspace still cannot touch it", async () => {
    setAdmin(MEMBER, true); // admin, but only granted ws-a
    const res = await repoPatch(await request("PATCH", "/api/repos/ws-b", MEMBER, { name: "Nope" }), idParams("ws-b"));
    expect(res.status).toBe(403);
  });
});

describe("/api/repos/[id]/treg", () => {
  test("no session is rejected", async () => {
    const res = await tregGet(await request("GET", "/api/repos/ws-a/treg"), idParams("ws-a"));
    expect(res.status).toBe(403);
  });

  test("a member can read the limits of a workspace they are granted on", async () => {
    const res = await tregGet(await request("GET", "/api/repos/ws-a/treg", MEMBER), idParams("ws-a"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.perCallCapUsd).toBeGreaterThan(0);
    expect(body.hasToken).toBe(false);
  });

  test("a member cannot read a workspace they are not granted on", async () => {
    const res = await tregGet(await request("GET", "/api/repos/ws-b/treg", MEMBER), idParams("ws-b"));
    expect(res.status).toBe(403);
  });

  test("a member cannot change the token or caps", async () => {
    const res = await tregPut(
      await request("PUT", "/api/repos/ws-a/treg", MEMBER, { token: "grab", dailyCapUsd: 9999 }),
      idParams("ws-a"),
    );
    expect(res.status).toBe(403);
    const after = await (await tregGet(await request("GET", "/api/repos/ws-a/treg", MEMBER), idParams("ws-a"))).json();
    expect(after.hasToken).toBe(false);
    expect(after.dailyCapUsd).not.toBe(9999);
  });

  test("an admin can set the token and caps, and the response never echoes the token", async () => {
    const res = await tregPut(
      await request("PUT", "/api/repos/ws-a/treg", OWNER, { token: "super-secret-treg-token", perCallCapUsd: 0.05, dailyCapUsd: 3 }),
      idParams("ws-a"),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("super-secret-treg-token");
    const body = JSON.parse(text);
    expect(body).toMatchObject({ hasToken: true, perCallCapUsd: 0.05, dailyCapUsd: 3 });

    // ...and a member reading it afterwards sees the limits but still not the token.
    const seen = await (await tregGet(await request("GET", "/api/repos/ws-a/treg", MEMBER), idParams("ws-a"))).text();
    expect(seen).not.toContain("super-secret-treg-token");
    expect(JSON.parse(seen).dailyCapUsd).toBe(3);
  });

  test("an admin's invalid cap is a 400 and changes nothing", async () => {
    const res = await tregPut(await request("PUT", "/api/repos/ws-a/treg", OWNER, { dailyCapUsd: -5, token: "should-not-land" }), idParams("ws-a"));
    expect(res.status).toBe(400);
    const after = await (await tregGet(await request("GET", "/api/repos/ws-a/treg", OWNER), idParams("ws-a"))).json();
    expect(after.hasToken).toBe(false);
  });

  test("a workspace that doesn't exist is refused, even for an admin (no grant on it)", async () => {
    const res = await tregPut(await request("PUT", "/api/repos/ws-missing/treg", OWNER, { dailyCapUsd: 1 }), idParams("ws-missing"));
    expect(res.status).toBe(403);
  });
});
