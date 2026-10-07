/**
 * Skill tools — check skill folders in the vault against the mechanical rules (lib/skills/lint.ts).
 * Read-scope: linting only reads files. The authoring guide is skills/skill-builder/SKILL.md.
 */

import { lintVaultSkills, MAX_SKILL_LINES, TOC_MIN_LINES } from "@/lib/skills/lint";
import type { Tool, ToolCtx } from "./tools";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = Record<string, any>;

export const SKILL_TOOLS: Tool[] = [
  {
    name: "skill_lint",
    description:
      "Check a skill folder (a SKILL.md plus reference files) against the mechanical rules: " +
      `SKILL.md under ${MAX_SKILL_LINES} lines; frontmatter with name, description and model; ` +
      `a contents list on every reference file over ${TOC_MIN_LINES} lines; references one level deep (SKILL.md links to them, they don't link onward); ` +
      "no broken links; and the skill in a plain folder (the indexer skips dot-folders, so .claude/skills/ is invisible to search). " +
      "Pass `path` for one skill, or omit it to lint every skill in the vault. Run it after writing or editing a skill; " +
      "for how to write a good one, brain_read skills/skill-builder/SKILL.md.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative skill folder or its SKILL.md, e.g. 'skills/my-skill'. Omit to lint all skills." },
      },
    },
    handler: ({ path }: Args, { dir }: ToolCtx) => {
      const skills = lintVaultSkills(dir, typeof path === "string" ? path : undefined);
      if (skills.length === 0) {
        return { ok: true, skills: [], hint: "No SKILL.md found in this vault. Skills live in plain folders such as skills/<name>/SKILL.md." };
      }
      return { ok: skills.every((s) => s.ok), skills };
    },
  },
];

export const SKILL_TOOL_MAP = new Map(SKILL_TOOLS.map((t) => [t.name, t]));
