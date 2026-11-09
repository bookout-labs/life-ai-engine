// Claude and Grok enforce .claude/settings.json permissions.deny natively, shell writes included: Claude checks
// >, >>, tee, cp, mv, rm and sed -i targets against Edit(...) rules, cd chains too (live test, #107, 2026-11-09).
// This hook applies its built-in list, plus any extra entries there, to every agent's file edits and shell writes,
// so emptying the settings file can't switch the guard off.
// Node built-ins only: a hook whose imports are missing fails open.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
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
const segment = (part: string) =>
  ({ "**/": "(?:.*/)?", "**": ".*", "*": "[^/]*" })[part] ?? part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
const toRegex = (glob: string) =>
  new RegExp(
    `^${glob
      .split(/(\*\*\/|\*\*|\*)/)
      .map(segment)
      .join("")}$`,
  );

// A target matches when it is a protected path or, for a remove or move, a folder above one, wildcards included:
// rm -rf .claude/rules, ~/.claude, or ~/.claude/projects/p (which holds p/memory). Above a ** the hook can't tell.
export function matches(path: string, glob: string, removes = false): boolean {
  if (toRegex(glob).test(path)) return true;
  if (!removes) return false;
  const parts = path.split("/");
  const globParts = glob.split("/");
  const above = globParts.slice(0, parts.length);
  return (
    parts.length < globParts.length &&
    !above.includes("**") &&
    parts.every((part, i) => toRegex(above[i] ?? "").test(part))
  );
}

// Shell writes are read here, for Codex (no native deny list) and as the fixed floor for Claude and Grok: redirect targets and file-writing commands' operands.
// Operands of rm, rmdir, unlink and mv remove what they name, so their folders are expanded (see tracked).
function shellTargets(command: string): { path: string; removes: boolean }[] {
  return command.split(/[;&|\n]+/).flatMap((statement) => {
    const tokens = (statement.match(/"(?:\\.|[^"\\])*"|'[^']*'|>>?|[^\s<>]+/g) ?? []).map((token) =>
      token.replace(/^(['"])(.*)\1$/, "$2"),
    );
    const writer = tokens.findIndex(
      (token) =>
        /^(?:tee|cp|mv|rm|rmdir|unlink|install|truncate|touch|ln)$/.test(token) ||
        (token === "sed" && tokens.some((t) => /^-i/.test(t))),
    );
    const command = tokens[writer] ?? "";
    const args = writer >= 0 ? tokens.slice(writer + 1) : [];
    // -t DIR / --target-directory=DIR names the destination up front; it then goes last like a plain destination.
    const t = args.findIndex((arg) => arg === "-t" || arg === "--target-directory");
    const target = t >= 0 ? args[t + 1] : args.find((arg) => arg.startsWith("--target-directory="))?.split("=")[1];
    const plain = args.filter((arg, i) => !arg.startsWith("-") && !(t >= 0 && i === t + 1));
    const operands = target ? [...plain, target] : plain;
    // mv removes its sources, not its destination; rm, rmdir and unlink remove every operand.
    const removed = (i: number) =>
      /^(?:rm|rmdir|unlink)$/.test(command) || (command === "mv" && i < operands.length - 1);
    // cp, mv, install and ln may write into a destination folder: dest/<source name>.
    const dest = operands.at(-1) ?? "";
    const into = /^(?:cp|mv|install|ln)$/.test(command)
      ? operands.slice(0, -1).map((source) => ({ path: join(dest, basename(source)), removes: false }))
      : [];
    return [
      ...operands.map((path, i) => ({ path, removes: removed(i) })),
      ...into,
      ...tokens.flatMap((token, i) => (/^>>?$/.test(token) ? [{ path: tokens[i + 1] ?? "", removes: false }] : [])),
    ];
  });
}

// A folder that is removed or moved takes the tracked files inside it, such as wiki/AGENTS.md.
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
  const targets = /Bash|exec_command|shell/i.test(tool)
    ? shellTargets(text)
    : [
        ...editedPaths(toolInput),
        ...(Array.isArray(input.edits) ? input.edits : []).flatMap((edit) => editedPaths(edit)),
        ...[...text.matchAll(/^\*\*\* (?:Delete File|Move to): (.+)$/gm)].map((match) => match[1]?.trim() ?? ""),
      ].map((path) => ({ path, removes: tool === "Delete" }));
  return targets
    .flatMap(({ path, removes }) => {
      const full = resolve(cwd, path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/)/, home));
      return (removes ? [full, ...tracked(full)] : [full]).map((target) => ({ target, removes }));
    })
    .filter(({ target, removes }) => globs.some((glob) => matches(target, glob, removes)))
    .map(({ target }) => target);
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
