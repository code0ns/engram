/**
 * The `instructions` string sent in the MCP initialize result.
 *
 * Clients (Claude Code, Claude.ai, Cursor, ChatGPT) put this in the model's context when they
 * connect. Without it a client knows only the server's name, so whether an agent ever reads the
 * vault or saves what it learned depends on it stumbling onto the right tool. This is what turns
 * "tell one tool once, every tool knows" into the default behaviour.
 *
 * Built from the tools the caller can actually see, so it never tells a read-only token to save,
 * never mentions the paid Treg tools to a workspace without a token, and never names a tool the
 * stdio server (brain_* only) doesn't serve. Kept short: it is read on every connection.
 */

export function serverInstructions(visible: Iterable<string>): string {
  const has = new Set(visible);
  const lines: string[] = [
    "Engram is this team's shared long-term memory: a markdown vault that other agents and people also read and write. Use it so work carries over between sessions and tools.",
  ];

  const start: string[] = [];
  if (has.has("brain_schema")) start.push("call brain_schema once to learn this vault's folders and conventions");
  if (has.has("brain_search")) start.push("brain_search the project, client or topic you are working on");
  if (has.has("brain_recent")) start.push("check brain_recent if you are picking up earlier work");
  if (start.length > 0) lines.push(`- Before starting: ${start.join(", then ")}.`);

  if (has.has("brain_search")) {
    lines.push(
      "- Search before answering anything about past decisions, prices, people or project state. Each hit has an `authority`: prefer `authoritative`, never quote `superseded` or `archived` notes as current.",
    );
  }

  if (has.has("brain_write")) {
    const tools = ["brain_write"];
    if (has.has("brain_append")) tools.push("brain_append to add to an existing note");
    lines.push(
      `- Save as you go: when a decision is made, a fact changes, or you learn something a teammate would need, write it down (${tools.join("; ")}). Read a note before overwriting it.` +
        (has.has("brain_supersede") ? " When a fact changes, use brain_supersede instead of adding a second note." : ""),
    );
    lines.push("- Don't save chatter, secrets or credentials, or what the code repository already records.");
  }

  if (has.has("tool_search")) {
    let api = "- Before using an external API, call tool_search: it checks this workspace's saved recipes first.";
    if (has.has("tool_call")) api += " tool_call spends this workspace's money, so confirm the price with tool_get first.";
    if (has.has("tool_recipe_save")) api += " Save endpoints you will reuse with tool_recipe_save, not every call.";
    lines.push(api);
  }

  if (has.has("skill_lint")) {
    lines.push(
      has.has("brain_write")
        ? "- After writing or editing a skill under skills/, run skill_lint on it."
        : "- To check a skill under skills/ against the authoring rules, run skill_lint on it.",
    );
  }

  return lines.join("\n");
}
