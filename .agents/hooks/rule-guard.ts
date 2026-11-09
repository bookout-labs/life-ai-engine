// Threat model: stop a well-meaning agent's normal edits to instruction and memory files, so rules go through
// .agents/rules.ts. Deliberate evasion and interpreter writes (node -e, python) are out of scope; CI's AGENTS.md
// drift check is the wall for repo files (#91, #107).
// Claude and Grok also enforce .claude/settings.json permissions.deny natively, their shell writes included.
// This hook covers every agent's file edits and Codex's plain shell writes.
// Node built-ins only: a hook whose imports are missing fails open.
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { repoRoot } from "./changes.ts";
import { editedPaths, readHookInput } from "./edits.ts";

const REASON =
  "Instruction and memory files are protected. Add an entry in .agents/rules.ts with trigger and a hook or check route, then run node .agents/scripts/rules.ts --write.";

// Always enforced, whatever the editable settings say; a test keeps .claude/settings.json a superset.
export const CORE = [
  "Edit(**/AGENTS.md)",
  "Edit(**/CLAUDE.md)",
  "Edit(/.claude/rules/**)",
  "Edit(~/.claude/CLAUDE.md)",
  "Edit(~/.claude/rules/**)",
  "Edit(~/.claude/projects/*/memory/**)",
  "Edit(~/.codex/AGENTS.md)",
  "Edit(~/.codex/rules/**)",
  "Edit(~/.codex/memories*)",
];

// Claude's anchors: ~/ is home, // is the filesystem root, anything else is the project.
export function denyGlobs(rules: unknown[], root: string, home: string): string[] {
  return rules.flatMap((rule) => {
    const glob = /^Edit\((.+)\)$/.exec(String(rule))?.[1];
    if (!glob) return [];
    if (glob.startsWith("~/")) return [join(home, glob.slice(2))];
    return [glob.startsWith("//") ? glob.slice(1) : join(root, glob)];
  });
}

// Like gitignore, ** crosses dot-folders (.claude/CLAUDE.md); node's matchesGlob skips them.
export function matches(path: string, glob: string): boolean {
  const pattern = glob
    .split(/(\*\*\/|\*\*|\*)/)
    .map(
      (part) => ({ "**/": "(?:.*/)?", "**": ".*", "*": "[^/]*" })[part] ?? part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${pattern}$`).test(path);
}

// Codex's plain shell writes: redirect targets and the operands of the usual file writers.
function shellTargets(command: string): string[] {
  // 2>&1 duplicates a stream and writes no file; left in, the split at & would leave an empty redirect target.
  return command
    .replace(/\d*>&\d+/g, " ")
    .split(/[;&|\n]+/)
    .flatMap((statement) => {
      const tokens = (statement.match(/"(?:\\.|[^"\\])*"|'[^']*'|>>?|[^\s<>]+/g) ?? []).map((token) =>
        token.replace(/^(['"])(.*)\1$/, "$2"),
      );
      const writer = tokens.findIndex(
        (token) =>
          /^(?:tee|cp|mv|rm|unlink|touch|truncate)$/.test(token) ||
          (token === "sed" && tokens.some((t) => /^-i/.test(t))),
      );
      const operands = writer >= 0 ? tokens.slice(writer + 1).filter((token) => !token.startsWith("-")) : [];
      return [
        // cp writes only its destination; mv also removes its sources.
        ...(tokens[writer] === "cp" ? operands.slice(-1) : operands),
        ...tokens.flatMap((token, i) => (/^>>?$/.test(token) ? [tokens[i + 1] ?? ""] : [])),
      ];
    });
}

export function protectedPaths(tool: string, toolInput: unknown, cwd: string, globs: string[], home: string): string[] {
  const input = (typeof toolInput === "string" ? { input: toolInput } : (toolInput ?? {})) as Record<string, unknown>;
  const text = [input.command, input.cmd, input.input].filter((value) => typeof value === "string").join("\n");
  const paths = /Bash|exec_command|shell/i.test(tool)
    ? shellTargets(text)
    : [
        ...editedPaths(toolInput),
        ...(Array.isArray(input.edits) ? input.edits : []).flatMap((edit) => editedPaths(edit)),
        ...[...text.matchAll(/^\*\*\* (?:Delete File|Move to): (.+)$/gm)].map((match) => match[1]?.trim() ?? ""),
      ];
  return paths
    .filter(Boolean)
    .map((path) => resolve(cwd, path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/)/, home)))
    .filter((path) => globs.some((glob) => matches(path, glob)));
}

if (import.meta.main) {
  const input = readHookInput();
  let cwd = input.cwd ?? process.cwd();
  try {
    // git reports the root by its real path (/var is /private/var on macOS), so paths must match it.
    cwd = realpathSync(cwd);
  } catch {
    // A missing cwd still resolves paths as given.
  }
  let root = cwd;
  try {
    root = repoRoot(cwd);
  } catch {
    // Outside a repo, cwd is the only anchor.
  }
  let extra: unknown = [];
  try {
    extra = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8")).permissions?.deny;
  } catch {
    // Unreadable settings leave the built-in list in force.
  }
  const globs = denyGlobs([...CORE, ...(Array.isArray(extra) ? extra : [])], root, homedir());
  const tool = (input as { tool_name?: unknown }).tool_name;
  if (protectedPaths(typeof tool === "string" ? tool : "", input.tool_input, cwd, globs, homedir()).length)
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
