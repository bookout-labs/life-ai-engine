// PreToolUse: point AIs to save.ts instead of raw git. GitHub's ruleset is the real wall.
import { readFileSync } from "node:fs";

type GuardInput = { tool_input?: { command?: string } };

// Anchored so `grep "git push"` doesn't match.
const BLOCKED: RegExp = /(^|[;&|\n]\s*)(git\s+(commit|push)|gh\s+pr\s+merge)\b/;

// Claude's practice runs.
const PRACTICE: RegExp = /\/scratchpad\//;

export function isBlocked(command: string): boolean {
  return BLOCKED.test(command) && !PRACTICE.test(command);
}

function readInput(): GuardInput {
  try {
    return JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

// Only when run as a hook, not when a test imports it.
if (import.meta.main && isBlocked(readInput().tool_input?.command ?? "")) {
  const reason: string = [
    "Blocked: in life-ai, save with save.ts instead of raw git commit, git push or gh pr merge.",
    'node .agents/scripts/save.ts --work <ID> -m "<what changed>" <files>',
    "If save.ts failed partway, stop and ask the user.",
  ].join("\n");

  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    }),
  );
}
