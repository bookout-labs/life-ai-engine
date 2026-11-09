import { readFileSync } from "node:fs";

export type HookInput = { session_id?: string; cwd?: string; tool_input?: unknown };

export function readHookInput(strict = false): HookInput {
  try {
    const input = JSON.parse(readFileSync(0, "utf8") || "{}");
    if (strict && (input === null || typeof input !== "object" || Array.isArray(input)))
      throw new Error("Invalid hook input");
    return input;
  } catch (error) {
    if (strict) throw error;
    return {};
  }
}

// Each agent names the file differently: Claude file_path, Grok path, Codex an apply_patch command.
export function editedPaths(toolInput: unknown): string[] {
  const input = (typeof toolInput === "string" ? { command: toolInput } : (toolInput ?? {})) as {
    file_path?: unknown;
    path?: unknown;
    command?: unknown;
    input?: unknown;
  };
  const paths = [input.file_path, input.path].filter((value): value is string => typeof value === "string");
  const patch = input.command ?? input.input;
  if (typeof patch === "string") {
    for (const match of patch.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)) {
      if (match[1]) paths.push(match[1].trim());
    }
  }
  return paths;
}

export function reply(event: "PreToolUse" | "PostToolUse" | "UserPromptSubmit", additionalContext: string): void {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } }));
}
