// Saves finished work from a T3 worktree: commit, push, PR as the App, auto-merge. GitHub's gate (main's copy) judges it.
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { added, leaks, missing, requireOpenIssue } from "./proof.ts";
import { waitForMerge } from "./save-wait.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    work: { type: "string" },
    message: { type: "string", short: "m" },
    agent: { type: "string" },
    proof: { type: "string" },
    issue: { type: "string" },
    regroup: { type: "string" },
    "no-wait": { type: "boolean", default: false },
  },
});

function fail(why: string): never {
  console.error(`save: ${why}`);
  process.exit(1);
}
const git = (...args: string[]): string =>
  execFileSync("git", args, { encoding: "utf8", stdio: "pipe", maxBuffer: 1 << 28 }).trim();

const APP = { id: "5673796", installation: "180008533", key: join(homedir(), ".config", "life-ai", "app.pem") };
const tokenArgs = ["token", "generate", "--app-id", APP.id, "--installation-id", APP.installation, "--key", APP.key];
const token: string = execFileSync("gh", [...tokenArgs, "--token-only"], { encoding: "utf8", stdio: "pipe" }).trim();
const gh = (...args: string[]): string =>
  execFileSync("gh", args, { encoding: "utf8", stdio: "pipe", env: { ...process.env, GH_TOKEN: token } }).trim();

// After three blocked rounds the agent regroups itself: the App posts it, and the gate counts the App's Regroup.
if (values.regroup) {
  if (!values.issue || !/^[1-9]\d*$/.test(values.issue)) fail("--regroup needs --issue <n>");
  const text = `Regroup: ${values.regroup}`;
  if (leaks([text])) fail("The regroup text matches the personal-term list.");
  gh("issue", "comment", values.issue, "-R", "bookout-labs/life-ai-engine", "--body", text);
  console.log(`Regrouped #${values.issue}`);
  if (positionals.length === 0) process.exit(0);
}

const work: string = values.work ?? "";
const message: string = values.message ?? "";
const proof: string = values.proof ?? "";
if (!/^[A-Z]+(\.\d+)+$/.test(work)) fail("Give a work ID, like --work LAB.1.3");
if (!message) fail('Give a message, like -m "what changed"');
if (positionals.length === 0) fail("Name the files to save. Nothing is saved by default.");
if (values.issue && !/^[1-9]\d*$/.test(values.issue)) fail("--issue is a Builds board issue number, like --issue 2");
if (/[\r\n]/.test(proof)) fail("--proof must be one line");

const branch: string = git("branch", "--show-current");
if (!branch || branch === "main") fail("Save from a T3 worktree thread, never from main.");

// git resolves folders, renames and deletions; the staged list is what the rules judge.
git("add", "-A", "--", ...positionals);
const files: string[] = git("diff", "--cached", "--name-only", "--no-renames", "-z").split("\0").filter(Boolean);
if (files.length === 0) {
  console.log("Nothing to save in those files.");
  process.exit(0);
}

const agent: string =
  values.agent ?? (process.env.CLAUDECODE ? "claude-code" : process.env.CODEX_THREAD_ID ? "codex" : "user");
const session: string = process.env.CLAUDE_CODE_SESSION_ID ?? process.env.CODEX_THREAD_ID ?? "terminal";
const trailers: string = `Work: ${work}\nAgent: ${agent}\nSession: ${session}`;
const body: string = [proof && `Proof: ${proof}`, values.issue && `Board: #${values.issue}`, trailers]
  .filter(Boolean)
  .join("\n");

const errors = missing(files, body);
if (errors.length) fail(errors.join("\n"));
try {
  if (values.issue) requireOpenIssue(values.issue);
} catch (err: unknown) {
  fail(err instanceof Error ? err.message : String(err));
}

// The repo is public, so a pushed branch is already published: personal terms are refused before the push.
let hits: number;
try {
  hits = leaks([
    files.join("\n"),
    added(git("diff", "--text", "-U0", "origin/main...HEAD")),
    added(git("diff", "--cached", "--text", "-U0")),
    message,
    body,
    git("log", "--format=%B", "origin/main..HEAD"),
  ]);
} catch (err) {
  fail(err instanceof Error ? err.message : "Personal scan failed.");
}
if (hits) fail(`${hits} line(s) match the personal-term list. Personal data lives in Neon and R2, never in git.`);

// Feedback, not the gate: CI's required check is the wall. Skipping it here only moves the failure to GitHub.
try {
  execFileSync("npm", ["run", "--silent", "check"], { stdio: "pipe" });
} catch (err) {
  const output = err as { stderr?: Buffer; stdout?: Buffer };
  fail(
    `npm run check failed. Fix it, then save again.\n${String(output.stdout ?? "")
      .split("\n")
      .slice(-8)
      .join("\n")}\n${String(output.stderr ?? "")
      .split("\n")
      .slice(-8)
      .join("\n")}`,
  );
}

git("commit", "-m", `${message}\n\n${trailers}`);
git("push", "-u", "origin", branch);
console.log(`1/3 pushed ${branch}`);

// A failed save leaves its PR open with auto-merge on; the next save from this branch refreshes it instead of opening another.
let pr: string = gh(
  "pr",
  "list",
  "-R",
  "bookout-labs/life-ai-engine",
  "--head",
  branch,
  "--state",
  "open",
  "--json",
  "url",
  "--jq",
  ".[0].url // empty",
);
if (pr) {
  gh("pr", "edit", pr, "--title", message, "--body", body);
  // Auto-merge stays bound to the commit it was first armed on, so a refreshed PR never queues; re-arm it.
  if (gh("pr", "view", pr, "--json", "autoMergeRequest", "--jq", ".autoMergeRequest != null") === "true")
    gh("pr", "merge", pr, "--disable-auto");
} else
  pr = gh(
    "pr",
    "create",
    "-R",
    "bookout-labs/life-ai-engine",
    "--base",
    "main",
    "--head",
    branch,
    "--title",
    message,
    "--body",
    body,
  );
gh("pr", "merge", pr, "--auto", "--merge", "--match-head-commit", git("rev-parse", "HEAD"));
console.log(`2/3 ${pr} merges when check, gate and secrets pass. Link it to this thread (link_pull_request).`);
if (values["no-wait"]) {
  console.log("Not waiting. Watch the PR (watch_pull_request); merged is not done until ship.yml's run passes.");
  process.exit(0);
}

try {
  await waitForMerge(gh, pr);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
// The queue merges with a merge commit, so this branch is its ancestor and fast-forwards onto the new main.
git("pull", "--ff-only", "origin", "main");
console.log(`3/3 merged ${pr}`);

const merged: string = git("rev-parse", "HEAD");
const fields = ["--json", "databaseId,url", "--jq", '.[0] | select(.) | "\\(.databaseId) \\(.url)"'];
for (let i = 0; i < 24; i++) {
  const run = gh("run", "list", "--workflow", "ship.yml", "--commit", merged, ...fields);
  if (run) {
    const [id = "", url = ""] = run.split(" ");
    try {
      gh("run", "watch", id, "--exit-status", "--interval", "5");
    } catch {
      fail(`merged, but the production check failed: ${url}. Fix it and save again.`);
    }
    console.log(`Production check passed: ${url}. ship.yml posts the evidence on the board issue.`);
    process.exit(0);
  }
  await sleep(5000);
}
fail("merged, but GitHub never started the production check (ship.yml).");
