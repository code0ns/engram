import fs from "node:fs";
import path from "node:path";
import { ALLOWED_EMAILS, DATA_ROOT } from "@/lib/config";
import { listRepos } from "@/lib/repos";

/**
 * Per-email workspace grants — which of the connected workspaces (lib/repos.ts) a
 * logged-in dashboard user may see and switch to. Sits UNDER the coarse ALLOWED_EMAILS
 * allowlist (lib/auth.ts's isAllowed): that gate still decides who can log in at all;
 * this store decides which workspace(s) they see once they're in. Same flat-JSON,
 * no-cache convention as lib/repos.ts/lib/tokens.ts — read fresh every call so a
 * revoked grant takes effect on the caller's very next request, not after a redeploy.
 */

const STATE_DIR = process.env.ENGRAM_STATE_DIR || DATA_ROOT;
const ACCESS_FILE = path.join(STATE_DIR, "access.json");

export interface AccessGrant {
  email: string;
  workspaceIds: string[];
  /** May manage who has access, workspace settings (name, git token, Treg token + caps) and
   *  add/delete workspaces. Explicit and visible on the People tab — see adminEmails(). */
  isAdmin?: boolean;
}

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function load(): AccessGrant[] {
  try {
    return JSON.parse(fs.readFileSync(ACCESS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function save(grants: AccessGrant[]): void {
  ensureStateDir();
  fs.writeFileSync(ACCESS_FILE, JSON.stringify(grants, null, 2));
}

/**
 * Live grants for an email. MIGRATION: an ALLOWED_EMAILS email with no grant record yet
 * is auto-granted every currently-existing workspace, once, so shipping this feature
 * cannot lock out someone who already had implicit full access. Only fires once a
 * workspace actually exists — an empty result on a fresh deploy (zero repos) must not
 * "freeze" a permanent empty grant, so the migration is retried on the next call instead
 * of being recorded as "checked, found nothing."
 */
export function grantsForEmail(email: string): string[] {
  const e = email.toLowerCase();
  const all = load();
  const rec = all.find((g) => g.email === e);
  if (rec) return rec.workspaceIds;

  if (ALLOWED_EMAILS.includes(e)) {
    const ids = listRepos().map((r) => r.id);
    if (ids.length > 0) {
      save([...all, { email: e, workspaceIds: ids }]);
      return ids;
    }
  }
  return [];
}

/** Upsert the full grant set for one email (their admin flag is untouched). */
export function setGrantsForEmail(email: string, workspaceIds: string[]): void {
  const e = email.toLowerCase();
  const all = load();
  const ids = [...new Set(workspaceIds)];
  const rec = all.find((g) => g.email === e);
  if (rec) rec.workspaceIds = ids;
  else all.push({ email: e, workspaceIds: ids });
  save(all);
}

/**
 * Revoke a person's access entirely. Writes an explicit EMPTY record rather than deleting it:
 * with no record, grantsForEmail()'s migration would hand an ALLOWED_EMAILS address every
 * workspace again on their next request. Refuses to remove the last admin.
 */
export function removeGrants(email: string): void {
  const e = email.toLowerCase();
  const all = load();
  if (adminEmails(all).length === 1 && adminEmails(all)[0] === e) {
    throw new Error("At least one admin is required — make someone else an admin first.");
  }
  const rest = all.filter((g) => g.email !== e);
  rest.push({ email: e, workspaceIds: [], isAdmin: false });
  save(rest);
}

/**
 * Who is an admin. Explicit `isAdmin` flags win. Until any flag exists (a deploy from before
 * admins existed) the first ALLOWED_EMAILS address is the owner — a bootstrap fallback only;
 * ensureAdminPersisted() writes it down as a real, visible flag the first time it safely can,
 * so after that nothing depends on env ordering.
 */
export function adminEmails(all: AccessGrant[] = load()): string[] {
  const explicit = all.filter((g) => g.isAdmin).map((g) => g.email);
  if (explicit.length > 0) return explicit;
  const owner = ALLOWED_EMAILS[0];
  return owner ? [owner] : [];
}

export function isAdmin(email: string): boolean {
  return adminEmails().includes(email.toLowerCase());
}

/**
 * Persist the bootstrap owner as an explicit admin. Safe moments only: the owner already has a
 * record, or a workspace exists to grant them (so we never freeze an empty record that would
 * block the existing "grant everything once" migration on a fresh, workspace-less deploy).
 */
function ensureAdminPersisted(all: AccessGrant[]): AccessGrant[] {
  if (all.some((g) => g.isAdmin)) return all;
  const owner = ALLOWED_EMAILS[0];
  if (!owner) return all;
  const hasRecord = all.some((g) => g.email === owner);
  if (!hasRecord && listRepos().length === 0) return all;
  materializeOwnerAdmin(all);
  save(all);
  return all;
}

/** Write the bootstrap owner into `all` as an explicit admin (no-op if explicit admins exist). */
function materializeOwnerAdmin(all: AccessGrant[]): void {
  if (all.some((g) => g.isAdmin)) return;
  const owner = ALLOWED_EMAILS[0];
  if (!owner) return;
  const rec = all.find((g) => g.email === owner);
  if (rec) rec.isAdmin = true;
  else all.push({ email: owner, workspaceIds: listRepos().map((r) => r.id), isAdmin: true });
}

/** Make someone an admin, or demote them. Refuses to demote the last admin. */
export function setAdmin(email: string, on: boolean): void {
  const e = email.toLowerCase();
  const all = load();
  if (!on && adminEmails(all).length === 1 && adminEmails(all)[0] === e) {
    throw new Error("At least one admin is required — make someone else an admin first.");
  }
  // Pin the bootstrap owner as a real admin first: otherwise the first explicit flag we write
  // would replace the fallback and silently demote them.
  materializeOwnerAdmin(all);
  let rec = all.find((g) => g.email === e);
  if (!rec) {
    rec = { email: e, workspaceIds: [] };
    all.push(rec);
  }
  if (on) rec.isAdmin = true;
  else delete rec.isAdmin;
  save(all);
}

/** Every grant record — for the /access page listing. Each record's `isAdmin` is the effective value. */
export function allGrants(): AccessGrant[] {
  const all = ensureAdminPersisted(load());
  const admins = new Set(adminEmails(all));
  return all.map((g) => ({ ...g, isAdmin: admins.has(g.email) }));
}

/** Grant one additional workspace to an email, without disturbing their other grants.
 *  Used when someone creates a new workspace — they should see what they just made. */
export function addGrant(email: string, workspaceId: string): void {
  const e = email.toLowerCase();
  const all = load();
  const rec = all.find((g) => g.email === e);
  if (rec) {
    if (!rec.workspaceIds.includes(workspaceId)) rec.workspaceIds.push(workspaceId);
  } else {
    all.push({ email: e, workspaceIds: [workspaceId] });
  }
  save(all);
}

/** Strip a deleted workspace out of every grant record. */
export function pruneWorkspace(workspaceId: string): void {
  save(load().map((g) => ({ ...g, workspaceIds: g.workspaceIds.filter((id) => id !== workspaceId) })));
}
