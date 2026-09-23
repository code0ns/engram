import fs from "node:fs";
import path from "node:path";
import { simpleGit, type StatusResult } from "simple-git";
import { SKIPPED, gitPausedFor, gitRead, invalidateGitReads, runGit, tryRunGit } from "@/lib/git-queue";
import { listRepos, vaultDirFor } from "@/lib/repos";
import { gitAuthor, gitSyncEnabled } from "@/lib/settings";
import { rebuildIndex } from "@/lib/vault/store";

/**
 * One sync/pull state per workspace directory, not a single global — different workspaces
 * can now be written to concurrently (lib/workspace-resolve.ts), and a note write in one
 * must not share a debounce timer or pending-reasons list with a write in another.
 *
 * Kept on `globalThis` for the same reason as before (see lib/git-queue.ts): this module is
 * compiled into several server chunks, so a plain module-level `Map` would still give each
 * chunk its own copy. Sharing via `globalThis` is what makes the single-writer guarantee
 * hold across route boundaries.
 */
interface SyncState {
  timer: ReturnType<typeof setTimeout> | null;
  pending: string[];
  /** The last thing that went wrong in a sync, surfaced by syncStatus() instead of only console. */
  lastError?: string;
  /** Consecutive pull failures — drives the loop's exponential backoff. */
  pullFailures: number;
}

const SYNC_KEY = Symbol.for("engram.git.sync");
type GlobalWithSync = typeof globalThis & { [SYNC_KEY]?: Map<string, SyncState> };

function syncState(dir: string): SyncState {
  const g = globalThis as GlobalWithSync;
  const map = (g[SYNC_KEY] ??= new Map());
  let s = map.get(dir);
  if (!s) {
    s = { timer: null, pending: [], pullFailures: 0 };
    map.set(dir, s);
  }
  return s;
}

const PULL_LOOP_KEY = Symbol.for("engram.git.pullLoopStarted");
type GlobalWithLoop = typeof globalThis & { [PULL_LOOP_KEY]?: boolean };

/**
 * How long a `syncStatus()` / `vaultActivity()` answer may be reused.
 *
 * These are the polled endpoints: the sidebar's workspace switcher refreshes `/api/sync` every
 * 10s and the dashboard refreshes `/api/activity` every 15s, per open tab. `syncStatus` alone was
 * two git children (`status` + `stash list`) every time, none of them serialized against the pull
 * and push that actually matter. Answers this fresh are indistinguishable to the reader and cost
 * one git process instead of one per tab. Any sync we run ourselves clears the cache immediately.
 */
const STATUS_TTL_MS = 4_000;
const ACTIVITY_TTL_MS = 8_000;

/**
 * The vault dir ONLY when it's safe to run git there: it must be its OWN repo root (a `.git`
 * directly inside it). This covers connected workspaces (their clone is a repo root) and a
 * self-hosted VAULT_DIR that is a real repo, while excluding the bundled sample vault — which
 * has no `.git` of its own and would otherwise resolve to Engram's own repo. Returns null if
 * unsafe, so we never commit the app itself or surface its history.
 */
export function gitVaultDir(dir: string): string | null {
  return fs.existsSync(path.join(dir, ".git")) ? dir : null;
}

/**
 * The environment for a git child process: the host environment with every `GIT_*` inherited
 * variable dropped, plus the identity and prompt settings this sync needs.
 *
 * simple-git refuses to spawn when certain variables are inherited from the host — `GIT_EDITOR`,
 * `GIT_ASKPASS`, `GIT_CONFIG_COUNT` and friends — because a hostile value would execute arbitrary
 * code or rewrite config. It throws, and the only symptom is a console.error while the vault
 * quietly stops syncing and the write tools keep answering `ok: true`.
 *
 * The previous version named two variables (`GIT_EDITOR`, `GIT_SEQUENCE_EDITOR`) and so had to be
 * right about a list that grows: `GIT_ASKPASS` alone is exported by both VS Code and the `gh` CLI.
 * Dropping the whole `GIT_*` namespace ends that game and is what we actually want — Engram sets
 * its own author, needs no editor, and must never inherit `GIT_DIR`, `GIT_WORK_TREE` or
 * `GIT_INDEX_FILE`, any of which would silently point the commit at the wrong repository.
 * `SSH_ASKPASS` is the one non-`GIT_` member of the same family.
 *
 * GIT_TERMINAL_PROMPT=0 stops a missing credential from hanging the push forever.
 */
function gitEnv(name: string, email: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith("GIT_") || k === "SSH_ASKPASS") continue;
    env[k] = v;
  }
  return {
    ...env,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_TERMINAL_PROMPT: "0",
  };
}

/**
 * A git client for the vault with the sanitised environment already applied — to EVERY command,
 * not just the commit. Pull and push spawn child processes through the same guard, so an
 * inherited `GIT_ASKPASS` broke them exactly as it broke commits. The read-only paths below use
 * this client too: `GIT_DIR` or `GIT_WORK_TREE` inherited from the host would point `log` and
 * `show` at some other repository and quietly serve its history as the vault's.
 */
function vaultGit(dir: string) {
  const { name, email } = gitAuthor();
  return simpleGit(dir, {
    // The queue in lib/git-queue.ts already guarantees one git child at a time; this shuts the
    // door simple-git leaves open by default (five), so no single client can widen it again.
    maxConcurrentProcesses: 1,
    // Kill a command that has printed nothing for two minutes rather than let it hold the queue
    // — and its git / git-remote-https / resolver threads — indefinitely. A vault is markdown:
    // two minutes of silence means the network is wedged, and wedged children that never exit
    // are how the container ran out of processes to fork in the first place.
    timeout: { block: 120_000 },
  }).env(gitEnv(name, email));
}

/**
 * The `<remote> <branch>` a pull names explicitly, or null when HEAD is detached.
 *
 * This is NOT what fixes "Cannot rebase onto multiple branches." — that error comes from two
 * fetches racing on `.git/FETCH_HEAD`, and it reproduces just as reliably with an explicit
 * refspec as without one (40/40 rounds either way against a local remote). Only serializing git
 * prevents it; see lib/git-queue.ts.
 *
 * Naming the refspec buys two smaller things. A bare `git pull --rebase` needs the current branch
 * to have tracking config, which a self-hosted VAULT_DIR repo (see gitVaultDir) may not have —
 * that fails with "There is no tracking information for the current branch", where falling back
 * to `origin/<current>` just works. And a detached HEAD gets a message naming the vault instead
 * of git's generic "You are not currently on a branch".
 */
function upstreamOf(status: StatusResult): { remote: string; branch: string } | null {
  if (status.detached || !status.current) return null;
  const slash = status.tracking?.indexOf("/") ?? -1;
  if (status.tracking && slash > 0) {
    // Only the FIRST slash separates them — `origin/feature/x` is remote `origin`, branch `feature/x`.
    return { remote: status.tracking.slice(0, slash), branch: status.tracking.slice(slash + 1) };
  }
  return { remote: "origin", branch: status.current };
}

async function pullRebase(g: ReturnType<typeof vaultGit>, up: ReturnType<typeof upstreamOf>): Promise<void> {
  if (!up) throw new Error("vault HEAD is detached — refusing to pull; check out a branch in the vault clone first");
  await g.pull(["--rebase", up.remote, up.branch]);
}

/**
 * Check if the remote branch exists. Returns false for empty repos (no commits on remote)
 * or when the remote is unreachable.
 */
async function remoteBranchExists(g: ReturnType<typeof vaultGit>, remote: string, branch: string): Promise<boolean> {
  try {
    // `git ls-remote --heads <remote> <branch>` returns the ref if it exists, empty otherwise
    const result = await g.listRemote(["--heads", remote, branch]);
    return result.trim().length > 0;
  } catch {
    // Network error or remote not found — caller should attempt push anyway to get a real error
    return false;
  }
}

/**
 * Debounced commit + pull --rebase + push of one workspace. No-op unless git-sync is on
 * AND the workspace is its own git repo (see gitVaultDir).
 */
export function requestSync(dir: string, reason: string): void {
  if (!gitSyncEnabled() || !gitVaultDir(dir)) return;
  const s = syncState(dir);
  s.pending.push(reason);
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => runSync(dir), 2500);
}

export interface SyncOutcome {
  committed: boolean;
  pulled: boolean;
  pushed: boolean;
  /** The rebase conflicted and was aborted: the local commit is safe, the vault is behind. */
  conflicted?: boolean;
  /** True when this was the first push to an empty remote repo. */
  firstPush?: boolean;
  error?: string;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Undo a rebase that stopped on a conflict, restoring the pre-pull state.
 *
 * A `git pull --rebase` that hits a conflict leaves the repo mid-rebase: HEAD detached, the
 * conflicted note carrying `<<<<<<<` markers in the working tree. Nothing here used to notice —
 * the error was logged and the next sync tick ran `git add -A` and committed, writing conflict
 * markers into the note and pushing them to the vault. Aborting puts our own commit back on the
 * branch with the note intact; we stay behind the remote until a human merges the two edits, and
 * `syncStatus().lastError` says so. Diverging visibly beats corrupting quietly.
 *
 * This is the failure mode the vault's own warning describes: "a second git writer causes merge
 * conflicts and lost edits (it already discarded a staging-URL update on 2026-07-14)".
 */
async function abortRebaseIfAny(dir: string, g: ReturnType<typeof vaultGit>): Promise<boolean> {
  const inRebase =
    fs.existsSync(path.join(dir, ".git", "rebase-merge")) || fs.existsSync(path.join(dir, ".git", "rebase-apply"));
  if (!inRebase) return false;
  try {
    await g.rebase(["--abort"]);
    console.error("[git] rebase conflicted — aborted; the vault is behind the remote until this is merged by hand");
    return true;
  } catch (e) {
    console.error("[git] rebase abort failed", e);
    return false;
  }
}

/**
 * Commit everything dirty in one workspace, then rebase onto the remote and push. Runs under
 * the git lock. Always returns an outcome — never `undefined` — so the caller can tell "ran"
 * from "skipped".
 *
 * Handles empty remote repos (first push): when the remote branch doesn't exist yet, skip the
 * pull and push with `-u` to establish tracking. This is the common case when someone connects
 * a brand-new empty GitHub repo and starts writing notes.
 *
 * Also handles clean working tree with unpushed commits: when there's nothing to commit but
 * the local branch is ahead of or behind the remote, still syncs with the remote.
 */
async function syncOnce(dir: string, reasons: string[]): Promise<SyncOutcome> {
  const out: SyncOutcome = { committed: false, pulled: false, pushed: false };
  try {
    const vaultDir = gitVaultDir(dir); // may have changed (workspace deleted) since the debounce fired
    if (!vaultDir) return out;
    const g = vaultGit(vaultDir);
    await g.add(["-A"]);
    const status = await g.status();

    const hasDirtyFiles = status.files.length > 0;
    const needsPull = status.behind > 0;
    const needsPush = status.ahead > 0 || !status.tracking;

    // Early return only when there's truly nothing to do: clean tree with no remote sync needed.
    if (!hasDirtyFiles && !needsPull && !needsPush) {
      return out;
    }

    // Commit any dirty files. Skip if the tree is already clean (e.g., ahead > 0 with nothing new).
    if (hasDirtyFiles) {
      await g.commit(`brain: ${reasons.length} change(s) — ${reasons.slice(0, 3).join("; ")}`);
      out.committed = true;
    }

    const up = upstreamOf(status);
    if (!up) {
      out.error = "vault HEAD is detached — check out a branch in the vault clone first";
      console.error("[git] sync skipped: detached HEAD");
      return out;
    }

    // Check if this is an empty remote (first push scenario). When the remote branch doesn't
    // exist, `git pull --rebase` fails with "Couldn't find remote ref" — skip it and push
    // directly with -u to establish tracking.
    const remoteExists = await remoteBranchExists(g, up.remote, up.branch);

    // Pull --rebase when:
    // - Remote branch exists (not a first push), AND
    // - We just committed OR we're behind the remote (need to incorporate remote changes)
    // Deliberately no `--autostash`: see the note on pullWorkspace. If a write landed in
    // the gap, `git pull --rebase` refuses on a dirty tree, which loses nothing; the next
    // tick retries.
    if (remoteExists && (out.committed || needsPull)) {
      const before = await g.revparse(["HEAD"]).catch(() => "");
      try {
        await pullRebase(g, up);
        out.pulled = true;
        const after = await g.revparse(["HEAD"]).catch(() => "");
        // A rebase that replayed our commit over remote work rewrote the tree; the index must
        // follow. Previously only pullWorkspace rebuilt, so commits arriving down THIS path left
        // search answering from pre-pull content until the watcher happened to catch up.
        if (before !== after) rebuildIndex(vaultDir);
      } catch (e) {
        const aborted = await abortRebaseIfAny(vaultDir, g);
        out.error = aborted
          ? `vault diverged from its remote and the rebase conflicted; the local commit is intact but unpushed. Merge by hand. (${errText(e)})`
          : errText(e);
        out.conflicted = aborted;
        console.error("[git] pull failed", e);
      }
    } else if (!remoteExists) {
      // Empty remote: skip pull, will push with -u below
      console.log(`[git] remote branch ${up.remote}/${up.branch} not found — first push to empty repo`);
    }

    // Push unless we're mid-conflict
    if (!out.conflicted) {
      try {
        // Use -u (set-upstream) so future pushes work even if this is the first commit.
        // This is idempotent: if tracking is already set, -u just confirms it.
        await g.push(["-u", up.remote, up.branch]);
        out.pushed = true;
        if (!remoteExists) {
          out.firstPush = true;
          console.log(`[git] first push to ${up.remote}/${up.branch} succeeded — tracking established`);
        }
      } catch (e) {
        const msg = errText(e);
        // Provide actionable guidance for common push failures
        if (msg.includes("Permission denied") || msg.includes("Authentication failed")) {
          out.error = `push failed: authentication error. Check that the workspace token has write access to the repo. (${msg})`;
        } else if (msg.includes("Repository not found")) {
          out.error = `push failed: repository not found. The remote repo may have been deleted, or the token lacks access. (${msg})`;
        } else if (msg.includes("remote rejected")) {
          out.error = `push failed: remote rejected the push. Check branch protection rules. (${msg})`;
        } else {
          out.error = `push failed: ${msg}`;
        }
        console.error("[git] push failed", e);
      }
    }
  } catch (e) {
    out.error = errText(e);
    console.error("[git] sync failed", e);
  }
  return out;
}

async function runSync(dir: string): Promise<void> {
  const s = syncState(dir);
  const reasons = s.pending;
  s.pending = [];
  s.timer = null; // this timer has fired; anything scheduled during the await is a new one
  const outcome = await tryRunGit(() => syncOnce(dir, reasons));
  if (outcome === SKIPPED) {
    // Git was busy with a pull. The changed files are still dirty on disk, so don't drop them:
    // re-queue the reasons and retry once the repo is free.
    s.pending.unshift(...reasons);
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => runSync(dir), 2500);
    return;
  }
  s.lastError = outcome.error;
  invalidateGitReads();
}

/** Run the debounced sync immediately. Returns SKIPPED-as-null when a pull holds the repo. */
export async function syncNow(dir: string, reason = "manual sync"): Promise<SyncOutcome | null> {
  if (!gitSyncEnabled() || !gitVaultDir(dir)) return null;
  const s = syncState(dir);
  const reasons = s.pending.length > 0 ? s.pending : [reason];
  s.pending = [];
  if (s.timer) clearTimeout(s.timer);
  s.timer = null;
  const outcome = await tryRunGit(() => syncOnce(dir, reasons));
  if (outcome === SKIPPED) {
    s.pending.unshift(...reasons);
    return null;
  }
  s.lastError = outcome.error;
  invalidateGitReads();
  return outcome;
}

/** Test seam: the reasons still waiting to be committed for this workspace. */
export function pendingReasons(dir: string): string[] {
  return [...syncState(dir).pending];
}

/** Get the last sync error for a workspace (cheap - no git calls). */
export function getLastSyncError(dir: string): string | undefined {
  return syncState(dir).lastError;
}

export async function syncStatus(dir: string) {
  const vaultDir = gitVaultDir(dir);
  if (!vaultDir || !gitSyncEnabled()) return { enabled: false as const };
  const s = syncState(dir);
  // Surfaced rather than hidden behind a generic error: when the breaker is open the dashboard's
  // "sync error" dot is telling the truth, but only this says the vault is fine and git is paused.
  const pausedMs = gitPausedFor();
  const paused = pausedMs > 0 ? { paused: Math.ceil(pausedMs / 1000) } : {};
  try {
    const result = await gitRead(`status:${vaultDir}`, STATUS_TTL_MS, async () => {
      const g = vaultGit(vaultDir);
      const st = await g.status();
      const stashed = await g.stashList().then((l) => l.total).catch(() => 0);

      // Detect "false green" scenario: git status shows ahead=0/behind=0 when there's no upstream.
      // This happens with empty remote repos where origin/main doesn't exist yet.
      let noUpstream = false;
      let remoteEmpty = false;
      let localCommits = 0;

      // Check if tracking is set (e.g., "origin/main")
      const hasTracking = !!st.tracking;
      if (!hasTracking && st.current && !st.detached) {
        noUpstream = true;
        // Check if the remote branch exists at all
        try {
          const refs = await g.listRemote(["--heads", "origin", st.current]);
          remoteEmpty = refs.trim().length === 0;
        } catch {
          remoteEmpty = true; // Network error or remote not found
        }

        // Count local commits that haven't been pushed
        // For untracked branches, count all commits (since there's no remote to compare)
        try {
          const log = await g.log({ maxCount: 100 });
          localCommits = log.total;
        } catch {
          // No commits at all (truly empty local repo)
          localCommits = 0;
        }
      }

      return { st, stashed, noUpstream, remoteEmpty, localCommits };
    });

    const { st, stashed, noUpstream, remoteEmpty, localCommits } = result;

    // Build the response with clear diagnostics for the false-green scenario
    const base = {
      enabled: true as const,
      dirty: st.files.length,
      ahead: st.ahead,
      behind: st.behind,
      branch: st.current,
      pending: s.pending.length,
      ...(stashed > 0 ? { stashed } : {}),
      ...paused,
      ...(s.lastError ? { lastError: s.lastError } : {}),
    };

    // Surface upstream issues that cause the "synced but never pushed" false green
    if (noUpstream) {
      return {
        ...base,
        noUpstream: true,
        ...(remoteEmpty ? { remoteEmpty: true } : {}),
        ...(localCommits > 0 ? { localCommits, unpushed: true } : {}),
        // Override ahead to show local commits when there's no upstream to compare against
        ahead: localCommits,
        warning: remoteEmpty
          ? `Remote branch origin/${st.current} does not exist (empty repo). ${localCommits} local commit(s) have never been pushed. Trigger a sync to push.`
          : `Branch has no upstream tracking. ${localCommits} local commit(s) may not be pushed.`,
      };
    }

    return base;
  } catch {
    return { enabled: true as const, error: true, ...paused };
  }
}

export interface PullResult {
  ok: boolean;
  changed: boolean;
  /** True when the pull was postponed because the vault had uncommitted writes. Not an error. */
  deferred?: boolean;
  error?: string;
}

/**
 * Pull remote commits into one workspace's clone (rebase). This is how changes pushed to the
 * repo from OUTSIDE Engram (an agent, a teammate, a direct git push) show up — the index is
 * rebuilt when HEAD moves. No-op for the sample/local vault (no `.git` of its own).
 *
 * Postpones itself rather than rebasing over uncommitted vault writes — see below.
 */
export async function pullWorkspace(dir: string): Promise<PullResult> {
  const result = await tryRunGit(async (): Promise<PullResult> => {
    const vaultDir = gitVaultDir(dir);
    if (!vaultDir) return { ok: true, changed: false };
    try {
      const g = vaultGit(vaultDir);

      // Never rebase over uncommitted vault writes.
      //
      // This used to pull with `--autostash`, which stashes the dirty working tree for the
      // duration of the rebase and restores it after. Two ways that loses a note, both silent:
      // while the stash is held the note on disk is back at HEAD, so a `brain_append` landing in
      // that window does its read-modify-write against stale content; and if the restore then
      // fails (upstream touched the same file, or the tree moved under it), git prints "Applying
      // autostash resulted in conflicts. Your changes are safe in the stash." and STILL EXITS 0 —
      // the note is reverted, the writes live only in a stash nobody reads, and every caller was
      // already told `ok: true`. Committing first (below) is strictly better than stashing: the
      // content is in history either way, and a commit is a place people look.
      const status = await g.status();
      const dirty = status.files.length > 0;
      if (dirty) {
        if (gitSyncEnabled()) {
          // The write-sync commits, then pulls, then pushes. Let it own this cycle.
          requestSync(vaultDir, "pull deferred — uncommitted vault writes");
          return { ok: true, changed: false, deferred: true };
        }
        return {
          ok: false,
          changed: false,
          error: "vault has uncommitted changes and git-sync is off — refusing to pull over them",
        };
      }

      const before = await g.revparse(["HEAD"]).catch(() => "");
      await pullRebase(g, upstreamOf(status)); // pull already fetches — a separate g.fetch() only doubles the child processes
      const after = await g.revparse(["HEAD"]).catch(() => "");
      const changed = before !== after;
      if (changed) rebuildIndex(vaultDir);
      return { ok: true, changed };
    } catch (e) {
      // Same reason as in syncOnce: a conflicted rebase left in place means the next `git add -A`
      // commits conflict markers into a note.
      const aborted = await abortRebaseIfAny(vaultDir, vaultGit(vaultDir));
      console.error("[git] pull failed", e);
      return {
        ok: false,
        changed: false,
        error: aborted ? `vault diverged from its remote; rebase aborted. Merge by hand. (${errText(e)})` : errText(e),
      };
    }
  });
  // SKIPPED = a sync was already in flight; a skipped tick is not an error.
  if (result === SKIPPED) return { ok: true, changed: false };
  invalidateGitReads();
  return result;
}

export interface ActivityEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

/**
 * Recent commits to a workspace — the "who did what to the brain" feed (agents + humans;
 * git-sync commits look like `brain: N change(s) — …`), most-recent first. Read-only. Empty
 * unless the workspace is its own git repo (see gitVaultDir), so we never surface Engram's own
 * history via the sample vault.
 *
 * `scopePath` limits this to commits that touched files under that vault-relative folder (git's
 * own path-scoped log) — used by the folder-browser view's "Recent activity" section.
 */
export async function vaultActivity(dir: string, maxCount = 50, scopePath?: string): Promise<ActivityEntry[]> {
  const vaultDir = gitVaultDir(dir);
  if (!vaultDir) return [];
  try {
    const log = await gitRead(`activity:${vaultDir}:${maxCount}:${scopePath ?? ""}`, ACTIVITY_TTL_MS, () =>
      vaultGit(vaultDir).log(scopePath ? { maxCount, file: scopePath } : { maxCount }),
    );
    return log.all.map((c) => ({
      hash: c.hash.slice(0, 7),
      message: c.message,
      author: c.author_name,
      date: c.date,
    }));
  } catch {
    return [];
  }
}

export interface CommitFile {
  /** Single-letter git status: A(dded) M(odified) D(eleted) R(enamed) C(opied) T(ypechange). */
  status: string;
  /** Vault-relative path of the file after the change (the new path for renames). */
  path: string;
  /** Previous path, for renames/copies. */
  oldPath?: string;
  /** The per-file patch body (starts with `diff --git`). Empty if none/binary. */
  diff: string;
  additions: number;
  deletions: number;
  binary: boolean;
}
export interface CommitDetail {
  hash: string;
  message: string;
  author: string;
  date: string;
  files: CommitFile[];
  truncated: boolean;
}

const MAX_DIFF = 200_000; // cap the total patch we ship to the client

function parseNameStatus(raw: string): { status: string; path: string; oldPath?: string }[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const status = parts[0][0];
      if ((status === "R" || status === "C") && parts.length >= 3) {
        return { status, oldPath: parts[1], path: parts[2] };
      }
      return { status, path: parts[parts.length - 1] };
    });
}

/** Path a per-file diff block targets (new path for renames, original for deletes). */
function diffBlockPath(chunk: string): string | null {
  const plus = chunk.match(/^\+\+\+ b\/(.+)$/m);
  if (plus && plus[1] !== "/dev/null") return plus[1];
  const minus = chunk.match(/^--- a\/(.+)$/m);
  if (minus && minus[1] !== "/dev/null") return minus[1];
  const git = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
  return git ? git[2] : null;
}

/** Split a raw `git show` patch into per-file blocks keyed by path. */
function splitDiffByFile(diff: string): Map<string, string> {
  const map = new Map<string, string>();
  const idx = diff.indexOf("diff --git ");
  if (idx === -1) return map;
  const parts = diff.slice(idx).split(/\ndiff --git /);
  parts.forEach((p, i) => {
    const chunk = (i === 0 ? p : "diff --git " + p).trimEnd();
    const path = diffBlockPath(chunk);
    if (path) map.set(path, chunk);
  });
  return map;
}

/**
 * What a single commit changed: metadata + each touched file with its own patch, add/del counts,
 * and status. Guarded like the rest — only the given workspace, only a valid hash. Null if unavailable.
 */
export async function commitChanges(dir: string, hash: string): Promise<CommitDetail | null> {
  const vaultDir = gitVaultDir(dir);
  if (!vaultDir) return null;
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) return null; // avoid passing arbitrary args to git
  try {
    // All three `show`s in one queue slot: they describe a single commit, so interleaving another
    // caller's pull between them would be three git children racing a rebase for no benefit.
    const { meta, nameStatus, rawDiff } = await runGit(async () => {
      const g = vaultGit(vaultDir);
      return {
        meta: await g.raw(["show", "-s", "--no-color", "--format=%h%x1f%an%x1f%aI%x1f%s", hash]),
        nameStatus: await g.raw(["show", "--no-color", "--format=", "--name-status", hash]),
        rawDiff: await g.raw(["show", "--no-color", "--format=", "--patch", hash]),
      };
    });
    const [shortHash, author, date, message] = meta.trim().split("\x1f");
    const truncated = rawDiff.length > MAX_DIFF;
    const blocks = splitDiffByFile(truncated ? rawDiff.slice(0, MAX_DIFF) : rawDiff);

    const files: CommitFile[] = parseNameStatus(nameStatus).map((f) => {
      const body = blocks.get(f.path) ?? "";
      return {
        ...f,
        diff: body,
        additions: (body.match(/^\+(?!\+\+)/gm) || []).length,
        deletions: (body.match(/^-(?!--)/gm) || []).length,
        binary: /^Binary files /m.test(body),
      };
    });

    return { hash: shortHash || hash.slice(0, 7), message: message ?? "", author: author ?? "", date: date ?? "", files, truncated };
  } catch {
    return null;
  }
}

/**
 * Poll the remote for EVERY connected workspace, so any of them stays fresh without a redeploy
 * — any workspace might be someone's current dashboard/token target at any time, not just one
 * global "active" one. Self-reschedules instead of using setInterval: the next tick is queued
 * only after the current sweep settles. Each workspace's pull still goes through the one shared
 * git queue (lib/git-queue.ts), so this loop's iterations serialize naturally.
 *
 * Whether the loop has started lives on `globalThis` for the same "module compiled into several
 * chunks" reason as syncState.
 */
export function startPullLoop(baseMs = 30_000): void {
  const g = globalThis as GlobalWithLoop;
  if (g[PULL_LOOP_KEY]) return;
  g[PULL_LOOP_KEY] = true;
  const tick = async () => {
    for (const repo of listRepos()) {
      const dir = vaultDirFor(repo.id);
      const s = syncState(dir);
      const res = await pullWorkspace(dir).catch(() => ({ ok: false as const, changed: false }));
      s.pullFailures = res.ok ? 0 : Math.min(s.pullFailures + 1, 5);
    }
    const t = setTimeout(tick, baseMs);
    t.unref?.();
  };
  const t = setTimeout(tick, baseMs);
  t.unref?.();
}
