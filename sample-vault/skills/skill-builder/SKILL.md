---
name: skill-builder
description: Write or revise an agent skill stored in this vault — a skills/<name>/ folder with a SKILL.md and optional reference files. Use when asked to create, split, tidy or review a skill, or when a long how-to note should become a skill. Covers frontmatter, structure, progressive disclosure and checking the result with skill_lint.
model: sonnet
title: Skill builder
type: skill
---

# Skill builder

A skill is a folder an agent loads when a task matches it: a `SKILL.md` with the instructions, plus
reference files the agent opens only when it needs them. This guide is how to write one that gets
picked for the right tasks and followed correctly.

**Always finish by running `skill_lint` on the folder and fixing every error.** The linter checks the
mechanical rules below; this guide covers the judgement it can't.

## Where skills live

- One skill per folder: `skills/<name>/SKILL.md`. Reference files sit beside it, e.g.
  `skills/<name>/reference/api.md`.
- **Use a plain folder.** The vault indexer skips dot-folders, so a skill under `.claude/skills/` is
  invisible to `brain_search` and `brain_read`. `skill_lint` reports it as an error.
- The folder name is the skill name: lowercase, digits and hyphens, at most 64 characters.

## Frontmatter

Every `SKILL.md` opens with YAML frontmatter. `name`, `description` and `model` are required; add
`title:` too, or the vault's sidebar and search show every skill as "SKILL".

```yaml
---
name: invoice-chaser            # same as the folder name
description: Draft polite payment reminders for overdue invoices, escalating by how late they are. Use when an invoice is past due or someone asks to chase a payment.
model: sonnet                   # alias (haiku, sonnet, opus) or a full model id
---
```

- **`description` decides whether the skill is ever used.** An agent sees only this line when
  choosing a skill, so say *what it does* and *when to use it*, with the words a user would actually
  say ("overdue", "chase a payment"). Third person, at most 1024 characters. "Helps with invoices"
  will never trigger reliably.
- **`model`**: the cheapest model that does the job well. Mechanical formatting → `haiku`; most
  writing and analysis → `sonnet`; hard multi-step reasoning → `opus`.

## Writing the body

**Be brief. The agent is already capable.** Every line of `SKILL.md` competes for its attention once
loaded. Explain only what it wouldn't know: this vault's conventions, the house style, the order that
matters, the traps you've seen.

- **Give one default path, not a menu.** "Use the template below" beats "you could use A, B or C".
  Mention an alternative only for the case that needs it.
- **Write steps as imperatives**, in order. For a workflow with more than three steps, add a checklist
  the agent can copy and tick off.
- **Show, don't describe.** One concrete input → output example teaches a format faster than a
  paragraph about it.
- **Build in a check.** If the output can be verified (a linter, a test, a re-read against the
  criteria), say so and say what to do when it fails.
- **Match strictness to risk.** Fragile operations (deploys, migrations, money) get exact commands
  and "do not deviate". Judgement work gets goals and criteria.
- **Use one term per concept.** Don't alternate "note", "page" and "doc" for the same thing.
- **No dates that go stale.** "Before August use the old API" rots; put history in a collapsed
  "Old behaviour" section or leave it out.

## Splitting into reference files

Keep `SKILL.md` as the overview and move detail into reference files once it grows:

- **`SKILL.md` stays under 500 lines.** Past that, split. (Aim far lower; most good skills are
  under 150.)
- **Link every reference file directly from `SKILL.md`**, with a line on when to open it:
  `For the full field list, see [reference/fields.md](reference/fields.md).` Agents read a linked
  file when they need it, so the link text is the only cue they get.
- **References are one level deep.** A reference file must not send the agent on to a third file:
  agents tend to skim nested files partially and miss what's at the bottom. If `fields.md` needs
  `enums.md`, link `enums.md` from `SKILL.md` too.
- **Reference files over 100 lines start with a contents list** (a `## Contents` heading and a list
  of the sections), so an agent that reads only the top still knows what's in the file.
- **Name files for what they hold**: `reference/pricing-rules.md`, not `doc2.md`.
- Split by when the content is needed (e.g. one file per output type), not by length alone.

### Linking

Use relative markdown links from `SKILL.md`, for example `[reference/fields.md](reference/fields.md)`.
**Don't use wikilinks between skill files**: `[[...]]` resolves by bare filename across the whole
vault, and every skill has a `SKILL.md`, so `[[SKILL]]` lands on whichever one sorts first. Links
inside code blocks are ignored by `skill_lint`, so examples like the one above are safe.

## Workflow

Copy this checklist and work through it:

```
- [ ] 1. Collect 2-3 real examples of the task and what a good result looked like
- [ ] 2. Write the frontmatter, description first: what + when, in the user's words
- [ ] 3. Draft SKILL.md: the steps, one example, the traps
- [ ] 4. Cut everything the agent would do right anyway
- [ ] 5. Move detail into reference files, each linked from SKILL.md
- [ ] 6. Run skill_lint on the folder; fix every error, read every warning
- [ ] 7. Try it: give a fresh agent a real task and watch where it goes wrong
- [ ] 8. Fix the skill (not the task) and repeat step 7
```

At step 7, watch for: the skill not being picked (fix the description), steps skipped (make them
explicit or add a check), a reference file never opened (improve its link text), or the agent
re-reading the same file (it is too long or badly split).

## Revising an existing skill

1. `brain_read` the `SKILL.md` and every file it links to.
2. Run `skill_lint` first, so you know the starting errors.
3. Change the smallest thing that fixes the observed failure; keep the description's trigger words
   unless they are the problem.
4. Run `skill_lint` again before saving.

## Template

```markdown
---
name: my-skill
description: <What it does>. Use when <the situations and words that should trigger it>.
model: sonnet
title: My skill
---

# My skill

<One or two sentences: what this produces and for whom.>

## Steps

1. <First action, imperative>
2. <Next action>
3. Check the result: <how to verify, and what to do if it fails>

## Example

Input: <a realistic request>
Output: <what a good result looks like>

## Traps

- <A mistake an agent would plausibly make, and the fix>

For <detail>, see [reference/<topic>.md](reference/<topic>.md).
```
