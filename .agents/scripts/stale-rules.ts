import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "../..");
const REPO = ["AGENTS.md", "CLAUDE.md", "docs", ".agents/rules", ".agents/skills", ".claude", ".codex"].map((p) =>
  join(repo, p),
);
// Every agent's own rules and memory; CI can't see these, so session start checks them.
const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
  cwd: repo,
  encoding: "utf8",
}).trim();
const project = resolve(common, "..").replace(/[^a-zA-Z0-9]/g, "-");
const OUTSIDE = [".claude/rules", ".claude/CLAUDE.md", `.claude/projects/${project}/memory`, ".codex/AGENTS.md"].map(
  (p) => join(homedir(), p),
);

export function untilIssues(text: string): { line: number; issue: number }[] {
  return text
    .split(/\r?\n/)
    .flatMap((line, index) =>
      /\buntil\b/i.test(line)
        ? [...line.matchAll(/(?<![\w/])#([1-9]\d*)\b/g)].map((m) => ({ line: index + 1, issue: Number(m[1]) }))
        : [],
    );
}

export function staleIssueLines(files: string[], isOpen: (issue: number) => boolean): string[] {
  return files.flatMap((path) =>
    untilIssues(readFileSync(path, "utf8"))
      .filter(({ issue }) => !isOpen(issue))
      .map(({ line, issue }) => `${path}:${line}: "until #${issue}" names a closed issue; update the rule.`),
  );
}

function markdown(path: string): string[] {
  if (!statSync(path).isDirectory()) return path.endsWith(".md") ? [path] : [];
  return readdirSync(path, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(path, f));
}

function vale(paths: string[]): string[] {
  try {
    execFileSync("vale", ["--config", join(repo, ".vale.ini"), "--output=line", ...paths], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return [];
  } catch (err: unknown) {
    const { stdout, message } = err as { stdout?: string; message: string };
    return (stdout?.trim() || `vale failed: ${message}`).split("\n");
  }
}

if (import.meta.main) {
  const paths = (process.argv.includes("--outside") ? OUTSIDE : REPO).filter((p) => existsSync(p));
  const cache = new Map<number, boolean>();
  const isOpen = (issue: number): boolean => {
    if (!cache.has(issue)) {
      const state = execFileSync(
        "gh",
        ["issue", "view", String(issue), "-R", "bookout-labs/life-ai-engine", "--json", "state", "--jq", ".state"],
        { encoding: "utf8", stdio: "pipe", timeout: 10_000 },
      ).trim();
      cache.set(issue, state === "OPEN");
    }
    return cache.get(issue) ?? false;
  };
  // Print what Vale found first, so a failed GitHub lookup can't hide it.
  const found = vale(paths);
  for (const line of found) console.error(line);
  let issues: string[];
  try {
    issues = staleIssueLines(paths.flatMap(markdown), isOpen);
  } catch (err: unknown) {
    issues = [`issue lookup failed: ${err instanceof Error ? err.message : String(err)}`];
  }
  for (const line of issues) console.error(line);
  if (found.length || issues.length) process.exitCode = 1;
}
