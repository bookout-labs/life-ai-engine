import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { matchesGlob, relative, resolve } from "node:path";
import { RULES } from "../rules.ts";
import { repoRoot } from "./changes.ts";
import { editedPaths, readHookInput, reply } from "./edits.ts";
import { optionalString, record } from "./parse.ts";

export function context(repo: string, paths: string[], cwd = repo, command = "", home = homedir()): string {
  return RULES.filter(
    (rule) =>
      rule.inject &&
      (paths.some((path) => {
        const absolute = resolve(cwd, path.replace(/^~(?=\/)/, home).replace(/^\$(?:HOME|\{HOME\})(?=\/)/, home));
        return rule.inject?.startsWith("~/")
          ? matchesGlob(absolute, rule.inject.replace("~", home))
          : matchesGlob(relative(repo, absolute), rule.inject ?? "");
      }) ||
        (rule.id === "wiki-context" && /(?:^|[\s"'])[^\s"']*pages\.ts["']?\s+(?:write|save)(?=\s|$)/.test(command))),
  )
    .map((rule) => (rule.context ? `${rule.rule}\n${readFileSync(resolve(repo, rule.context), "utf8")}` : rule.rule))
    .join("\n\n");
}

if (import.meta.main) {
  try {
    const input = readHookInput(true);
    const cwd = input.cwd ?? process.cwd();
    const tool = record(
      typeof input.tool_input === "string" ? { command: input.tool_input } : (input.tool_input ?? {}),
    );
    const command = optionalString(tool.command) ?? optionalString(tool.cmd) ?? "";
    let repo: string;
    try {
      repo = repoRoot(cwd);
    } catch {
      process.exit(0);
    }
    const text = context(repo, editedPaths(input.tool_input), cwd, command);
    if (text) reply("PreToolUse", text);
  } catch {
    reply("PreToolUse", "Code context could not be loaded. Check the checkout before editing.");
  }
}
