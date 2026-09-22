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

/** Upsert the full grant set for one email. */
export function setGrantsForEmail(email: string, workspaceIds: string[]): void {
  const e = email.toLowerCase();
  const all = load().filter((g) => g.email !== e);
  all.push({ email: e, workspaceIds: [...new Set(workspaceIds)] });
  save(all);
}

/** Revoke a person's access entirely. */
export function removeGrants(email: string): void {
  save(load().filter((g) => g.email !== email.toLowerCase()));
}

/** Every grant record — for the /access page listing. */
export function allGrants(): AccessGrant[] {
  return load();
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
