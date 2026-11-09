// Stop: note files changed during this reply and not saved. turn-start.ts raises them on the user's next message,
// because blocking here forces an extra reply that buries the real answer in T3.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { notePath, repoRoot, type Snapshot, snapshot } from "./changes.ts";

try {
  const input: { session_id?: string; cwd?: string } = JSON.parse(readFileSync(0, "utf8") || "{}");
  const repo = repoRoot(input.cwd ?? process.cwd());
  const session = input.session_id ?? "unknown";

  // Baseline from turn-start.ts, refreshed here for AIs without that hook.
  const startNote = notePath(repo, "turn-start", session);
  const atStart: Snapshot = existsSync(startNote) ? JSON.parse(readFileSync(startNote, "utf8")) : {};
  const now = snapshot(repo);
  writeFileSync(startNote, JSON.stringify(now));

  const unsaved = Object.fromEntries(Object.entries(now).filter(([path, mtime]) => atStart[path] !== mtime));
  const note = notePath(repo, "unsaved", session);
  if (Object.keys(unsaved).length > 0) writeFileSync(note, JSON.stringify(unsaved));
  else rmSync(note, { force: true });
} catch {
  // Never trap the session.
}
