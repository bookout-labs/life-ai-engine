// Stops a well-meaning agent's file edits to instruction and memory files, so rules go through .agents/rules.ts.
// Claude and Grok also enforce permissions.deny in .claude/settings.json natively, shell writes included.
// Other agents' shell and interpreter writes are out of scope; CI's AGENTS.md drift check is the wall (#91, #107).
import { homedir } from "node:os";
import { resolve } from "node:path";
import { readHookInput } from "./edits.ts";

const REASON =
  "Instruction and memory files are protected. Add an entry in .agents/rules.ts with trigger and a hook or check route, then run node .agents/scripts/rules.ts --write.";

// The places permissions.deny lists, at any depth and in home: AGENTS.md, CLAUDE.md, rule folders and memory.
const PROTECTED =
  /(?:^|\/)(?:AGENTS|CLAUDE)\.md$|\/\.claude\/rules\/|\/\.claude\/projects\/[^/]+\/memory\/|\/\.codex\/(?:rules\/|memories)/;

export function denies(toolInput: unknown, cwd: string, home = homedir()): string | undefined {
  const input = (typeof toolInput === "string" ? { input: toolInput } : (toolInput ?? {})) as Record<string, unknown>;
  const items = [input, ...(Array.isArray(input.edits) ? input.edits : [])] as Record<string, unknown>[];
  const named = items.flatMap((item) => [item?.file_path, item?.path]).filter((value) => value !== undefined);
  if (named.some((value) => typeof value !== "string")) return `Cannot inspect this edit. ${REASON}`;
  // Codex names its files in apply_patch headers.
  const patch = [input.command, input.input].filter((value) => typeof value === "string").join("\n");
  const patched = [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)];
  const paths = [...(named as string[]), ...patched.map((match) => match[1]?.trim() ?? "")];
  return paths.some((path) => PROTECTED.test(resolve(cwd, path.replace(/^~(?=\/)/, home)))) ? REASON : undefined;
}

if (import.meta.main) {
  const input = readHookInput();
  const reason = denies(input.tool_input, input.cwd ?? process.cwd());
  if (reason)
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }),
    );
}
