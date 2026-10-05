/**
 * skill_lint — the mechanical rules for a skill folder (a SKILL.md plus its reference files).
 *
 * Only what a machine can check without judgement lives here; the craft (when to split, how to
 * word a description) is in skills/skill-builder/SKILL.md. The rules:
 *
 *   - SKILL.md exists and is under MAX_SKILL_LINES lines.
 *   - Its frontmatter parses and has `name`, `description` and `model`.
 *   - Every reference file over TOC_MIN_LINES lines opens with a contents list.
 *   - References are one level deep: SKILL.md links to them; they don't link onward to each other.
 *   - The skill lives in a plain folder: the vault indexer skips dot-folders, so a skill under
 *     `.claude/skills/` is invisible to brain_search and brain_read.
 *
 * `lintSkill` is pure (paths + contents in, issues out) so the rules can be tested without a disk.
 */

import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { resolveInVault } from "@/lib/vault/paths";

export const SKILL_FILE = "SKILL.md";
/** SKILL.md must be shorter than this. */
export const MAX_SKILL_LINES = 500;
/** Reference files longer than this need a contents list. */
export const TOC_MIN_LINES = 100;
/** How far into a reference file the contents list may start. */
const TOC_SEARCH_LINES = 40;
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;
/** Directories never walked when looking for skills: not content, and potentially huge. */
const SKIP_DIRS = new Set([".git", "node_modules", ".next"]);
const MAX_FILES_PER_SKILL = 500;

export type Severity = "error" | "warning";

export interface LintIssue {
  rule: string;
  severity: Severity;
  /** Path relative to the skill folder (or the folder itself for folder-level rules). */
  file: string;
  message: string;
}

export interface SkillLintResult {
  /** Vault-relative skill folder. */
  skill: string;
  ok: boolean;
  errors: number;
  warnings: number;
  issues: LintIssue[];
}

export interface SkillFiles {
  /** Every file in the skill folder, relative to it, POSIX separators. */
  paths: string[];
  /** Contents of the markdown files among them. */
  markdown: Map<string, string>;
}

export function countLines(content: string): number {
  if (content === "") return 0;
  const n = content.split(/\r?\n/).length;
  return /\r?\n$/.test(content) ? n - 1 : n;
}

/** Drop fenced code blocks and inline code, so example links inside them aren't checked. */
function stripCode(md: string): string {
  return md.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "").replace(/`[^`\n]*`/g, "");
}

/** Local link targets in a markdown file (no URLs, no pure #anchors), anchor/query stripped. */
export function localLinks(md: string): string[] {
  const out: string[] = [];
  const re = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
  for (const m of stripCode(md).matchAll(re)) {
    const target = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("/")) continue;
    const bare = target.split("#")[0].split("?")[0];
    let clean = bare;
    try {
      clean = decodeURI(bare);
    } catch {
      /* malformed %-escape: check the link as written */
    }
    if (clean) out.push(clean);
  }
  return out;
}

/** Resolve a link from `fromFile` (skill-relative) to a skill-relative path, or null if it escapes. */
function resolveLink(fromFile: string, target: string): string | null {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), target));
  if (joined === ".." || joined.startsWith("../")) return null;
  return joined.replace(/^\.\//, "");
}

function hasContentsList(md: string): boolean {
  const head = md.split(/\r?\n/).slice(0, TOC_SEARCH_LINES);
  if (head.some((l) => /^#{1,6}\s+(table of\s+)?contents\b/i.test(l.trim()))) return true;
  const anchorItems = head.filter((l) => /^\s*([-*+]|\d+\.)\s+\[[^\]]+\]\(#[^)]+\)/.test(l));
  return anchorItems.length >= 3;
}

const isMarkdown = (p: string) => /\.md$/i.test(p);

/** Lint one skill folder. `skillDir` is vault-relative and only used for folder-level rules. */
export function lintSkill(skillDir: string, files: SkillFiles): SkillLintResult {
  const issues: LintIssue[] = [];
  const add = (severity: Severity, rule: string, file: string, message: string) =>
    issues.push({ rule, severity, file, message });
  const folder = skillDir.replace(/\\/g, "/").replace(/\/+$/, "") || ".";

  const dotSegment = folder.split("/").find((seg) => seg.startsWith(".") && seg !== ".");
  if (dotSegment) {
    add(
      "error",
      "plain-folder",
      ".",
      `The skill is inside the dot-folder "${dotSegment}". The vault indexer skips dot-folders, so this skill is invisible to brain_search and brain_read. Move it to a plain folder such as skills/${path.posix.basename(folder)}/.`,
    );
  }

  const skillMd = files.markdown.get(SKILL_FILE);
  if (skillMd === undefined) {
    add("error", "skill-md", SKILL_FILE, `No ${SKILL_FILE} in this folder. A skill is a folder with a ${SKILL_FILE} at its root.`);
    return finish(folder, issues);
  }

  // ── SKILL.md length ───────────────────────────────────────────────────────
  const lines = countLines(skillMd);
  if (lines >= MAX_SKILL_LINES) {
    add(
      "error",
      "skill-md-length",
      SKILL_FILE,
      `${SKILL_FILE} is ${lines} lines; keep it under ${MAX_SKILL_LINES}. Move detail into reference files linked from ${SKILL_FILE}.`,
    );
  }

  // ── Frontmatter ───────────────────────────────────────────────────────────
  let fm: Record<string, unknown> | null = null;
  if (!/^---\r?\n/.test(skillMd)) {
    add("error", "frontmatter", SKILL_FILE, `${SKILL_FILE} has no YAML frontmatter. It needs name, description and model.`);
  } else {
    try {
      fm = matter(skillMd).data ?? {};
    } catch (e) {
      add("error", "frontmatter", SKILL_FILE, `${SKILL_FILE} frontmatter does not parse: ${(e as Error).message}`);
    }
  }
  if (fm) {
    for (const key of ["name", "description", "model"]) {
      const v = fm[key];
      if (typeof v !== "string" || v.trim() === "") {
        add("error", "frontmatter", SKILL_FILE, `Frontmatter is missing \`${key}\` (a non-empty string).`);
      }
    }
    const name = typeof fm.name === "string" ? fm.name.trim() : "";
    if (name) {
      if (!NAME_RE.test(name) || name.length > MAX_NAME) {
        add("error", "frontmatter", SKILL_FILE, `name "${name}" must be lowercase letters, digits and hyphens, at most ${MAX_NAME} characters.`);
      }
      const base = path.posix.basename(folder);
      if (base !== "." && name !== base) {
        add("warning", "frontmatter", SKILL_FILE, `name "${name}" differs from its folder "${base}". Keep them the same so the skill is easy to find.`);
      }
    }
    if (typeof fm.description === "string" && fm.description.length > MAX_DESCRIPTION) {
      add("error", "frontmatter", SKILL_FILE, `description is ${fm.description.length} characters; keep it at most ${MAX_DESCRIPTION}.`);
    }
  }

  // ── References: existence and depth ───────────────────────────────────────
  const pathSet = new Set(files.paths);
  const level1 = new Set<string>();
  for (const target of localLinks(skillMd)) {
    const rel = resolveLink(SKILL_FILE, target);
    if (rel === null) {
      add("warning", "reference-outside-skill", SKILL_FILE, `Link "${target}" points outside the skill folder. Keep a skill self-contained.`);
      continue;
    }
    if (!pathSet.has(rel)) {
      add("error", "broken-reference", SKILL_FILE, `Link "${target}" points to ${rel}, which does not exist.`);
      continue;
    }
    if (isMarkdown(rel) && rel !== SKILL_FILE) level1.add(rel);
  }

  const nested = new Set<string>();
  for (const ref of level1) {
    for (const target of localLinks(files.markdown.get(ref) ?? "")) {
      const rel = resolveLink(ref, target);
      if (rel === null || rel === SKILL_FILE || rel === ref || !isMarkdown(rel)) continue;
      if (!pathSet.has(rel)) {
        add("error", "broken-reference", ref, `Link "${target}" points to ${rel}, which does not exist.`);
        continue;
      }
      nested.add(rel);
      add(
        "error",
        "reference-depth",
        ref,
        `${ref} links on to ${rel}. Keep references one level deep: link ${rel} from ${SKILL_FILE} directly, so an agent reading ${SKILL_FILE} sees every file it might need.`,
      );
    }
  }

  // ── Reference files: contents list, reachability ──────────────────────────
  for (const [file, content] of files.markdown) {
    if (file === SKILL_FILE) continue;
    const n = countLines(content);
    if (n > TOC_MIN_LINES && !hasContentsList(content)) {
      add(
        "error",
        "reference-toc",
        file,
        `${file} is ${n} lines but has no contents list. Start it with a "## Contents" list of its sections, so a partial read still shows what is in it.`,
      );
    }
    if (!level1.has(file) && !nested.has(file)) {
      add("warning", "orphan-reference", file, `${file} is not linked from ${SKILL_FILE}, so an agent following the skill will never open it.`);
    }
  }

  return finish(folder, issues);
}

function finish(skill: string, issues: LintIssue[]): SkillLintResult {
  const errors = issues.filter((i) => i.severity === "error").length;
  return { skill, ok: errors === 0, errors, warnings: issues.length - errors, issues };
}

// ── Disk access ─────────────────────────────────────────────────────────────

/** Read a skill folder (vault-relative) into the shape lintSkill takes. */
export function loadSkillFiles(vaultDir: string, skillDir: string): SkillFiles {
  const root = resolveInVault(vaultDir, skillDir);
  const paths: string[] = [];
  const markdown = new Map<string, string>();
  const walk = (abs: string, rel: string) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (paths.length >= MAX_FILES_PER_SKILL) return;
      if (SKIP_DIRS.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = path.join(abs, e.name);
      if (e.isDirectory()) walk(childAbs, childRel);
      else if (e.isFile()) {
        paths.push(childRel);
        if (isMarkdown(e.name)) markdown.set(childRel, fs.readFileSync(childAbs, "utf8"));
      }
    }
  };
  walk(root, "");
  return { paths, markdown };
}

/**
 * Every folder in the vault holding a SKILL.md, dot-folders included: a skill hidden in
 * `.claude/skills/` is exactly what the plain-folder rule should report, so it must be found.
 */
export function findSkillDirs(vaultDir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === SKILL_FILE)) out.push(rel || ".");
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(path.join(abs, e.name), rel ? `${rel}/${e.name}` : e.name);
    }
  };
  walk(vaultDir, "");
  return out.sort();
}

/** Lint one skill (folder or its SKILL.md, vault-relative), or every skill in the vault. */
export function lintVaultSkills(vaultDir: string, target?: string): SkillLintResult[] {
  if (target && target.trim()) {
    let rel = target.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (path.posix.basename(rel) === SKILL_FILE) rel = path.posix.dirname(rel);
    const abs = resolveInVault(vaultDir, rel || ".");
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw new Error(`No skill folder at ${target}. Pass a vault-relative folder such as skills/my-skill.`);
    }
    return [lintSkill(rel || ".", loadSkillFiles(vaultDir, rel || "."))];
  }
  return findSkillDirs(vaultDir).map((d) => lintSkill(d, loadSkillFiles(vaultDir, d)));
}
