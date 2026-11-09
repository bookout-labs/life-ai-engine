// Shared by turn-start.ts and stop-check.ts.
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

export type Snapshot = Record<string, number>; // path -> mtime, 0 if deleted

// From the hook's cwd, never CLAUDE_PROJECT_DIR, which a parent agent can leak into a worktree subagent.
export function repoRoot(cwd: string): string {
  return git(cwd, "--show-toplevel");
}

function git(cwd: string, flag: string): string {
  return execFileSync("git", ["rev-parse", "--path-format=absolute", flag], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

export function snapshot(repo: string): Snapshot {
  // -z keeps paths with spaces intact.
  const out: string = execFileSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], {
    cwd: repo,
    encoding: "utf8",
    stdio: "pipe",
  });
  const entries: string[] = out.split("\0").filter(Boolean);
  const snap: Snapshot = {};
  let skipNext = false; // a rename's old path follows it
  for (const entry of entries) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const status: string = entry.slice(0, 2);
    const path: string = entry.slice(3);
    skipNext = status.includes("R") || status.includes("C");
    try {
      snap[path] = statSync(join(repo, path)).mtimeMs;
    } catch {
      snap[path] = 0;
    }
  }
  return snap;
}

// In the git dir so git never sees it; in a worktree .git is a file, so ask git where the dir is.
export function notePath(repo: string, name: string, session: string): string {
  return join(git(repo, "--git-dir"), `${name}-${session}`);
}

// Files a reply left unsaved that nobody has touched since; a newer mtime means the user may be mid-edit, a missing path means it was saved.
export function stillUnsaved(leftUnsaved: Snapshot, now: Snapshot): string[] {
  return Object.keys(leftUnsaved)
    .filter((path) => now[path] === leftUnsaved[path])
    .sort();
}
