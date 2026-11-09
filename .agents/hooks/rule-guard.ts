// Claude and Grok enforce .claude/settings.json permissions.deny natively, shell writes included.
// This hook applies its built-in list, plus any extra entries there, to file-edit tools for every agent and to shell writes for Codex.
// Node built-ins only: a hook whose imports are missing fails open.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { repoRoot } from "./changes.ts";
import { editedPaths, readHookInput } from "./edits.ts";

const REASON =
  "Instruction and memory files are protected. Add an entry in .agents/rules.ts with trigger and a hook or check route, then run node .agents/scripts/rules.ts --write.";

// Always enforced, whatever the editable settings say; a test keeps .claude/settings.json a superset for native enforcement.
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

// Like gitignore, ** crosses dot-folders too (.claude/CLAUDE.md); node's matchesGlob skips them.
// A target also matches when it is, or contains, a protected folder: rm -rf .claude/rules or ~/.claude.
export function matches(path: string, glob: string): boolean {
  const fixed = glob.slice(0, glob.search(/\*|$/)).replace(/\/[^/]*$/, "");
  if (fixed === path || fixed.startsWith(`${path}/`)) return true;
  const pattern = glob
    .replace(/\/\*\*$/, "\0")
    .split(/(\0|\*\*\/|\*\*|\*)/)
    .map(
      (part) =>
        ({ "\0": "(?:/.*)?", "**/": "(?:.*/)?", "**": ".*", "*": "[^/]*" })[part] ??
        part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${pattern}$`).test(path);
}

// Codex has no native deny list, so its shell writes are read here: redirect targets and file-writing commands' operands.
function shellTargets(command: string): string[] {
  return command.split(/[;&|\n]+/).flatMap((statement) => {
    const tokens = (statement.match(/"(?:\\.|[^"\\])*"|'[^']*'|>>?|[^\s<>]+/g) ?? []).map((token) =>
      token.replace(/^(['"])(.*)\1$/, "$2"),
    );
    const writer = tokens.findIndex(
      (token) =>
        /^(?:tee|cp|mv|rm|unlink|install|truncate|touch|ln)$/.test(token) ||
        (token === "sed" && tokens.some((t) => /^-i/.test(t))),
    );
    return [
      ...(writer >= 0 ? tokens.slice(writer + 1).filter((token) => !token.startsWith("-")) : []),
      ...tokens.flatMap((token, i) => (/^>>?$/.test(token) ? [tokens[i + 1] ?? ""] : [])),
    ];
  });
}

// A folder an rm or mv targets also takes the tracked files inside it, such as wiki/AGENTS.md.
function tracked(path: string): string[] {
  try {
    if (!statSync(path).isDirectory()) return [];
    const files = execFileSync("git", ["-C", path, "ls-files", "-z"], { encoding: "utf8", stdio: "pipe" });
    return files
      .split("\0")
      .filter(Boolean)
      .map((file) => join(path, file));
  } catch {
    return [];
  }
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
  const shell = /Bash|exec_command|shell/i.test(tool);
  return paths
    .map((path) => resolve(cwd, path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/)/, home)))
    .flatMap((path) => (shell ? [path, ...tracked(path)] : [path]))
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
  const raw = (input as { tool_name?: unknown }).tool_name;
  const tool = typeof raw === "string" ? raw : "";
  const deny = (reason: string) =>
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }),
    );
  let extra: unknown = [];
  try {
    extra = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8")).permissions?.deny;
  } catch {
    // Unreadable settings leave the built-in list in force.
  }
  const globs = denyGlobs([...CORE, ...(Array.isArray(extra) ? extra : [])], root, homedir());
  if (protectedPaths(tool, input.tool_input, cwd, globs, homedir()).length) deny(REASON);
}
