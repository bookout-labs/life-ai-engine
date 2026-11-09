// UserPromptSubmit: raise files the last reply left unsaved, then snapshot so stop-check.ts sees only this reply's changes.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { notePath, repoRoot, snapshot, stillUnsaved } from "./changes.ts";
import { reply } from "./edits.ts";

try {
  const input: { session_id?: string; cwd?: string } = JSON.parse(readFileSync(0, "utf8") || "{}");
  const repo = repoRoot(input.cwd ?? process.cwd());
  const session = input.session_id ?? "unknown";
  const now = snapshot(repo);

  const note = notePath(repo, "unsaved", session);
  if (existsSync(note)) {
    const files = stillUnsaved(JSON.parse(readFileSync(note, "utf8")), now);
    rmSync(note);
    if (files.length > 0) {
      reply(
        "UserPromptSubmit",
        [
          "Your last reply changed these files and didn't save them:",
          ...files.map((path) => `  ${path}`),
          'Before answering, save the finished ones: node .agents/scripts/save.ts --work <ID> -m "<what changed>" <files>',
          "Skip unfinished work and anything waiting on the user's answer.",
        ].join("\n"),
      );
    }
  }

  writeFileSync(notePath(repo, "turn-start", session), JSON.stringify(now));
} catch {
  // Never block the user's message.
}
