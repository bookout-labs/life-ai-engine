// Claude and Grok enforce .claude/settings.json permissions.deny natively, shell writes included.
// This hook applies the same list to file-edit tools for every agent, so Codex is covered too.
// Node built-ins only: a hook whose imports are missing fails open.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, matchesGlob, resolve } from "node:path";
import { repoRoot } from "./changes.ts";
import { editedPaths, readHookInput } from "./edits.ts";

const REASON =
  "Instruction and memory files are protected. Add an entry in .agents/rules.ts with trigger and a hook or check route, then run node .agents/scripts/rules.ts --write.";

// Claude's anchors: ~/ is home, // is the filesystem root, anything else is the project.
export function denyGlobs(settings: string, root: string, home: string): string[] {
  const deny: unknown = JSON.parse(settings).permissions?.deny;
  return (Array.isArray(deny) ? deny : []).flatMap((rule) => {
    const glob = /^Edit\((.+)\)$/.exec(String(rule))?.[1];
    if (!glob) return [];
    if (glob.startsWith("~/")) return [join(home, glob.slice(2))];
    return [glob.startsWith("//") ? glob.slice(1) : join(root, glob)];
  });
}

export function protectedPaths(toolInput: unknown, cwd: string, globs: string[], home: string): string[] {
  const input = (typeof toolInput === "string" ? { input: toolInput } : (toolInput ?? {})) as Record<string, unknown>;
  const patch = [input.command, input.input].filter((value) => typeof value === "string").join("\n");
  const moved = [...patch.matchAll(/^\*\*\* (?:Delete File|Move to): (.+)$/gm)].map((match) => match[1]?.trim() ?? "");
  return [...editedPaths(toolInput), ...moved]
    .map((path) => resolve(cwd, path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/)/, home)))
    .filter((path) => globs.some((glob) => matchesGlob(path, glob)));
}

if (import.meta.main) {
  const input = readHookInput();
  const cwd = input.cwd ?? process.cwd();
  let root = cwd;
  try {
    root = repoRoot(cwd);
  } catch {
    // Outside a repo, cwd is the only anchor.
  }
  const globs = denyGlobs(readFileSync(join(root, ".claude/settings.json"), "utf8"), root, homedir());
  if (protectedPaths(input.tool_input, cwd, globs, homedir()).length)
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: REASON,
        },
      }),
    );
}
