import { execFileSync } from "node:child_process";
import { repoRoot } from "./changes.ts";

const repo = repoRoot(process.cwd());

function report(message: string): void {
  console.log(
    JSON.stringify({
      systemMessage: message,
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: message },
    }),
  );
}

const notes: string[] = [];
try {
  execFileSync("git", ["fetch", "origin", "main"], { cwd: repo, stdio: "pipe" });
  const behind = execFileSync("git", ["rev-list", "--count", "HEAD..FETCH_HEAD"], {
    cwd: repo,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
  notes.push(`Fetched origin/main. ${behind} commit(s) ahead of this branch; working files unchanged.`);
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message.trim().split("\n").at(-1) : String(err);
  notes.push(`git fetch FAILED: ${msg}. Tell the user before editing.`);
}

// CI can't see the agent's own rules and memory; this warns, never blocks.
try {
  execFileSync("node", [`${repo}/.agents/scripts/stale-rules.ts`, "--outside"], {
    cwd: repo,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 60_000,
  });
} catch (err: unknown) {
  const { stderr, message } = err as { stderr?: string; message: string };
  notes.push(`Stale rules outside the repo:\n${stderr?.trim() || message}`);
}
report(notes.join("\n\n"));
