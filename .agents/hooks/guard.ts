// PreToolUse for Codex: point it to save.ts instead of raw git. Claude denies these natively (permissions.deny);
// GitHub's protect-main ruleset and the gate are the real wall.
import { readHookInput } from "./edits.ts";

// Anchored so `grep "git push"` doesn't match.
const BLOCKED = /(^|[;&|\n]\s*)(git\s+(commit|push)|gh\s+pr\s+merge)\b/;

export function isBlocked(command: string): boolean {
  return BLOCKED.test(command);
}

// Only when run as a hook, not when a test imports it.
const command = import.meta.main && (readHookInput().tool_input as { command?: unknown } | undefined)?.command;
if (typeof command === "string" && isBlocked(command)) {
  const reason = [
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
