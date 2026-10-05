import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { countLines, lintSkill, lintVaultSkills, localLinks, MAX_SKILL_LINES, TOC_MIN_LINES, type SkillFiles } from "./lint";

const FM = "---\nname: demo\ndescription: Demo skill. Use when testing.\nmodel: sonnet\n---\n";

function files(md: Record<string, string>, extra: string[] = []): SkillFiles {
  return { paths: [...Object.keys(md), ...extra], markdown: new Map(Object.entries(md)) };
}

function rules(dir: string, f: SkillFiles) {
  return lintSkill(dir, f).issues.map((i) => `${i.severity}:${i.rule}:${i.file}`);
}

const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";

describe("a clean skill", () => {
  test("passes with no issues", () => {
    const r = lintSkill("skills/demo", files({ "SKILL.md": `${FM}# Demo\nSee [the API](reference/api.md).\n`, "reference/api.md": "# API\n" }));
    expect(r).toMatchObject({ ok: true, errors: 0, warnings: 0, issues: [] });
  });

  test("the shipped skill-builder skill passes its own linter", () => {
    const sample = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../sample-vault");
    const [r] = lintVaultSkills(sample, "skills/skill-builder");
    expect(r.issues).toEqual([]);
  });
});

describe("SKILL.md length", () => {
  test(`fails at ${MAX_SKILL_LINES} lines, passes just under`, () => {
    const fmLines = countLines(FM);
    const at = files({ "SKILL.md": FM + lines(MAX_SKILL_LINES - fmLines) });
    const under = files({ "SKILL.md": FM + lines(MAX_SKILL_LINES - fmLines - 1) });
    expect(rules("skills/demo", at)).toContain("error:skill-md-length:SKILL.md");
    expect(rules("skills/demo", under)).not.toContain("error:skill-md-length:SKILL.md");
  });

  test("countLines ignores the trailing newline and handles CRLF", () => {
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\r\nb")).toBe(2);
    expect(countLines("")).toBe(0);
  });
});

describe("frontmatter", () => {
  test("missing name, description and model are each errors", () => {
    const r = lintSkill("skills/demo", files({ "SKILL.md": "---\ntitle: x\n---\nbody\n" }));
    expect(r.issues.filter((i) => i.rule === "frontmatter").map((i) => i.message)).toEqual([
      expect.stringContaining("`name`"),
      expect.stringContaining("`description`"),
      expect.stringContaining("`model`"),
    ]);
  });

  test("no frontmatter at all is one error, not four", () => {
    const r = lintSkill("skills/demo", files({ "SKILL.md": "# Just a body\n" }));
    expect(r.issues.filter((i) => i.rule === "frontmatter")).toHaveLength(1);
  });

  test("unparseable YAML is reported", () => {
    const r = lintSkill("skills/demo", files({ "SKILL.md": "---\nname: [unclosed\n---\n" }));
    expect(r.issues.some((i) => i.rule === "frontmatter" && /does not parse/.test(i.message))).toBe(true);
  });

  test("a badly formed name is an error; a name differing from the folder is a warning", () => {
    const bad = FM.replace("name: demo", "name: Demo_Skill");
    expect(rules("skills/Demo_Skill", files({ "SKILL.md": bad }))).toContain("error:frontmatter:SKILL.md");
    expect(rules("skills/other", files({ "SKILL.md": FM }))).toEqual(["warning:frontmatter:SKILL.md"]);
  });
});

describe("plain folders", () => {
  test("a skill under a dot-folder is an error — the indexer would never see it", () => {
    expect(rules(".claude/skills/demo", files({ "SKILL.md": FM }))).toContain("error:plain-folder:.");
  });

  test("a folder with no SKILL.md is an error", () => {
    expect(rules("skills/demo", files({ "notes.md": "x" }))).toContain("error:skill-md:SKILL.md");
  });
});

describe("references", () => {
  test("a broken link from SKILL.md is an error", () => {
    expect(rules("skills/demo", files({ "SKILL.md": `${FM}[x](reference/missing.md)\n` }))).toContain("error:broken-reference:SKILL.md");
  });

  test("a reference that links on to another reference breaks the one-level rule", () => {
    const f = files({
      "SKILL.md": `${FM}[a](reference/a.md)\n`,
      "reference/a.md": "# A\nSee [b](b.md).\n",
      "reference/b.md": "# B\n",
    });
    expect(rules("skills/demo", f)).toEqual(["error:reference-depth:reference/a.md"]);
  });

  test("linking back to SKILL.md or to itself is fine", () => {
    const f = files({ "SKILL.md": `${FM}[a](reference/a.md)\n`, "reference/a.md": "[back](../SKILL.md) [top](a.md#top)\n" });
    expect(lintSkill("skills/demo", f).issues).toEqual([]);
  });

  test("a reference file nothing links to is a warning", () => {
    const f = files({ "SKILL.md": FM, "reference/lost.md": "# Lost\n" });
    expect(rules("skills/demo", f)).toEqual(["warning:orphan-reference:reference/lost.md"]);
  });

  test(`a reference over ${TOC_MIN_LINES} lines needs a contents list`, () => {
    const long = `# Big\n${lines(TOC_MIN_LINES + 5)}`;
    const withToc = `# Big\n\n## Contents\n- Setup\n- Usage\n${lines(TOC_MIN_LINES + 5)}`;
    const md = (ref: string) => files({ "SKILL.md": `${FM}[big](big.md)\n`, "big.md": ref });
    expect(rules("skills/demo", md(long))).toEqual(["error:reference-toc:big.md"]);
    expect(lintSkill("skills/demo", md(withToc)).issues).toEqual([]);
  });

  test("links pointing outside the skill folder are a warning", () => {
    expect(rules("skills/demo", files({ "SKILL.md": `${FM}[x](../other/SKILL.md)\n` }))).toEqual([
      "warning:reference-outside-skill:SKILL.md",
    ]);
  });

  test("links to non-markdown files must exist but are not references", () => {
    const f = files({ "SKILL.md": `${FM}Run [the script](scripts/run.py).\n` }, ["scripts/run.py"]);
    expect(lintSkill("skills/demo", f).issues).toEqual([]);
  });
});

describe("localLinks", () => {
  test("skips URLs, anchors and anything inside code", () => {
    const md = [
      "[web](https://example.com) [mail](mailto:a@b.c) [anchor](#top)",
      "`[inline](inline.md)`",
      "```",
      "[fenced](fenced.md)",
      "```",
      "[real](real.md#section) ![img](img/a.png \"title\")",
    ].join("\n");
    expect(localLinks(md)).toEqual(["real.md", "img/a.png"]);
  });
});

describe("lintVaultSkills", () => {
  test("finds every SKILL.md, including ones hidden in dot-folders", () => {
    const vault = process.env.VAULT_DIR!;
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
      fs.writeFileSync(path.join(vault, rel), content, "utf8");
    };
    write("skills/zzlint-ok/SKILL.md", FM.replace("name: demo", "name: zzlint-ok"));
    write(".claude/skills/zzlint-hidden/SKILL.md", FM.replace("name: demo", "name: zzlint-hidden"));

    const results = lintVaultSkills(vault);
    const byDir = new Map(results.map((r) => [r.skill, r]));
    expect(byDir.get("skills/zzlint-ok")?.ok).toBe(true);
    expect(byDir.get(".claude/skills/zzlint-hidden")?.issues.map((i) => i.rule)).toContain("plain-folder");
  });

  test("an unknown or escaping path is refused", () => {
    const vault = process.env.VAULT_DIR!;
    expect(() => lintVaultSkills(vault, "skills/does-not-exist")).toThrow(/No skill folder/);
    expect(() => lintVaultSkills(vault, "../../etc")).toThrow(/escapes the vault/);
  });
});
