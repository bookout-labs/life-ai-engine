import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import { repoRoot } from "./changes.ts";
import { editedPaths, readHookInput } from "./edits.ts";
import { array, optionalString, record } from "./parse.ts";

function parseInput(raw: unknown) {
  const input = record(typeof raw === "string" ? { input: raw } : (raw ?? {}));
  const paths = (value: unknown) => {
    const item = record(value);
    return { file_path: optionalString(item.file_path), path: optionalString(item.path) };
  };
  return {
    ...paths(input),
    command: optionalString(input.command),
    cmd: optionalString(input.cmd),
    input: optionalString(input.input),
    edits: input.edits === undefined ? [] : array(input.edits).map(paths),
  };
}
const ADD_RULE =
  "Add an entry in .agents/rules.ts with trigger and a hook or check route, then run node .agents/scripts/rules.ts --write.";

function protectedPath(path: string, cwd: string, root: string, home: string): boolean {
  const absolute = resolve(cwd, path.replace(/^~(?=\/)/, home).replace(/^\$(?:HOME|\{HOME\})(?=\/)/, home));
  const local = relative(root, absolute);
  const global = relative(home, absolute);
  return (
    /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/.test(local) ||
    local === "docs/skill-map.md" ||
    /^(?:\.agents|\.claude)\/rules(?:\/|$)/.test(local) ||
    /^\.claude\/projects\/[^/]+\/memory(?:\/|$)/.test(global) ||
    /^\.claude\/rules(?:\/|$)/.test(global) ||
    // Codex keeps memory in SQLite and global rules in execpolicy files.
    /^\.codex\/(?:memories[^/]*|rules(?:\/.*)?)$/.test(global) ||
    /^(?:\.claude\/CLAUDE\.md|\.codex\/AGENTS\.md)$/.test(global)
  );
}

export function decision(
  tool: string,
  raw: unknown,
  cwd: string,
  home = homedir(),
  // Paths are judged from the repo root, so a session in a subfolder can't slip past.
  root = cwd,
): { permissionDecision: "deny"; permissionDecisionReason: string } | undefined {
  let input: ReturnType<typeof parseInput>;
  try {
    input = parseInput(raw);
  } catch {
    return { permissionDecision: "deny", permissionDecisionReason: `Cannot inspect write input. ${ADD_RULE}` };
  }
  const command = input.command ?? input.cmd ?? input.input ?? "";
  const shell = /(?:Bash|exec_command|shell)/i.test(tool);
  let paths = [...editedPaths({ ...input, command }), ...(input.edits ?? []).flatMap((edit) => editedPaths(edit))];
  paths.push(
    ...[...command.matchAll(/^\*\*\* (?:Delete File|Move to|Update File): (.+)$/gm)].map((match) => match[1] ?? ""),
  );
  if (shell) {
    if (/^\s*node\s+\.agents\/scripts\/rules\.ts\s+--write\s*$/.test(command)) return undefined;
    paths = [];
    for (const statement of command.split(/[;&|\n]+/)) {
      const tokens = (statement.match(/"(?:\\.|[^"\\])*"|'[^']*'|>>?|[^\s<>]+/g) ?? []).map((token) =>
        token.replace(/^(['"])(.*)\1$/, "$2"),
      );
      const mutator = tokens.findIndex(
        (token) =>
          /^(?:tee|cp|mv|rm|unlink|rmdir|install|truncate|touch)$/.test(token) ||
          (token === "sed" && tokens.some((t) => /^-i/.test(t))),
      );
      if (mutator >= 0) paths.push(...tokens.slice(mutator + 1).filter((token) => !token.startsWith("-")));
      for (let i = 0; i < tokens.length; i++) if (/^>>?$/.test(tokens[i] ?? "")) paths.push(tokens[i + 1] ?? "");
    }
  }
  if (paths.some((path) => protectedPath(path, cwd, root, home)))
    return {
      permissionDecision: "deny",
      permissionDecisionReason: `Instruction and memory files are protected. ${ADD_RULE}`,
    };
  return undefined;
}

if (import.meta.main) {
  try {
    const input = readHookInput(true);
    const tool = optionalString(record(input).tool_name);
    const cwd = input.cwd ?? process.cwd();
    let root = cwd;
    try {
      root = repoRoot(cwd);
    } catch {
      // Outside a repo, cwd is the only anchor.
    }
    const result = decision(tool ?? "Write", input.tool_input, cwd, homedir(), root);
    if (result) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...result } }));
  } catch {
    console.error("Instruction guard could not inspect this write. Blocked.");
    process.exitCode = 2;
  }
}
