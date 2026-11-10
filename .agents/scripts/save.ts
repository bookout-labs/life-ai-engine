// Saves finished work from a T3 worktree: commit, push, PR as the App, then queue it. GitHub's gate (main's copy)
// judges it and the merge queue merges it; T3's PR watch reports back, so saving never waits.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { added, leaks, missing, requireOpenIssue } from "./proof.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    work: { type: "string" },
    message: { type: "string", short: "m" },
    agent: { type: "string" },
    proof: { type: "string" },
    issue: { type: "string" },
    regroup: { type: "string" },
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
if (spawnSync("git", ["fetch", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"]).status !== 0)
  fail("git fetch failed. Check origin access, then save again.");
const remote = `origin/${branch}`;
// A merge that stops can be continued; a merge that succeeds but conflicts replaying the autostash cannot.
const update = (ref: string) =>
  `Run git merge --autostash ${ref}. If the merge stops on conflicts, resolve them and run git merge --continue. If only the autostash replay conflicts, resolve those files; your changes stay in git stash list until you drop them.`;
const refs = ["origin/main"];
const exists = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}`]).status;
if (exists === 0) refs.push(remote);
else if (exists !== 1) fail("Cannot establish remote branch status.");
// Only a merge this run starts may be aborted; one already in progress holds the agent's resolutions.
if (spawnSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).status === 0)
  fail("A merge is in progress. Finish it with git merge --continue, then save again.");
for (const ref of refs) {
  const status = spawnSync("git", ["merge-base", "--is-ancestor", ref, "HEAD"]).status;
  if (status !== 0 && status !== 1) fail("git merge-base failed. Cannot establish branch freshness.");
  // A stale branch takes a clean merge itself; a conflict or an overlapping edit still stops for the agent.
  if (status === 1 && spawnSync("git", ["merge", "--no-edit", ref], { stdio: "pipe" }).status !== 0) {
    spawnSync("git", ["merge", "--abort"], { stdio: "pipe" });
    fail(`Branch is stale and ${ref} does not merge cleanly. ${update(ref)}`);
  }
  if (status === 1) console.log(`Merged ${ref}`);
}
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch (err) {
    // Deleted paths still need their existing ancestors resolved.
    if (!(err instanceof Error && "code" in err && err.code === "ENOENT") || lstatSync(path, { throwIfNoEntry: false }))
      throw err;
    return join(canonical(dirname(path)), basename(path));
  }
}
const root = realpathSync(git("rev-parse", "--show-toplevel"));
function within(base: string, path: string): string | undefined {
  const rel = relative(base, path);
  return rel === ".." || rel.startsWith(`..${sep}`) ? undefined : rel;
}
let paths: string[];
try {
  paths = positionals.flatMap((path) => {
    const absolute = resolve(path);
    const location = join(canonical(dirname(absolute)), basename(absolute));
    const named = within(root, location);
    if (named === undefined) fail(`Path resolves outside the repository: ${path}`);
    const staged = [named || "."];
    if (lstatSync(location, { throwIfNoEntry: false })?.isSymbolicLink() && existsSync(location)) {
      const target = realpathSync(location);
      const inside = within(root, target);
      if (inside !== undefined && within(target, location) === undefined) staged.push(inside || ".");
    }
    return staged;
  });
} catch (err) {
  fail(`Cannot resolve save path: ${err instanceof Error ? err.message : String(err)}`);
}
// A path already removed with git rm is staged and gone from disk and the index, so git add would refuse it.
const present = (path: string) =>
  lstatSync(join(root, path), { throwIfNoEntry: false }) !== undefined ||
  git("-C", root, "ls-files", "--", path) !== "";
for (const path of paths.filter((path) => !present(path)))
  if (git("-C", root, "diff", "--cached", "--name-only", "--", path) === "") fail(`Nothing to save at ${path}.`);
const addable = paths.filter(present);
if (addable.length) git("-C", root, "add", "-A", "--", ...addable);
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
// The repo is public, so a pushed branch is already published: personal terms are refused before the push.
let hits: number;
try {
  if (values.issue) requireOpenIssue(values.issue);
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
  const tail = (part?: Buffer) =>
    String(part ?? "")
      .split("\n")
      .slice(-8)
      .join("\n");
  fail(`npm run check failed. Fix it, then save again.\n${tail(output.stdout)}\n${tail(output.stderr)}`);
}

git("commit", "-m", `${message}\n\n${trailers}`);
try {
  git("push", "-u", "origin", branch);
} catch {
  fail(`Push failed. Fetch origin, then ${update(remote)} Then save again.`);
}
console.log(`1/2 pushed ${branch}`);

// A failed save leaves its PR open; the next save from this branch refreshes it instead of opening another.
// The merge queue picks the merge method and re-tests the combined tree, so queueing is one plain call.
const repoArgs = ["-R", "bookout-labs/life-ai-engine"];
const lookup = ["--state", "open", "--json", "url", "--jq", ".[0].url // empty"];
let pr = gh("pr", "list", ...repoArgs, "--head", branch, ...lookup);
if (pr) gh("pr", "edit", pr, "--title", message, "--body", body);
else pr = gh("pr", "create", ...repoArgs, "--base", "main", "--head", branch, "--title", message, "--body", body);
try {
  gh("pr", "merge", pr, "--auto");
} catch {
  fail(`${pr} is pushed but not queued. Save again to queue it.`);
}
console.log(`2/2 ${pr} is queued and merges when check, gate and secrets pass.`);
console.log(
  "Link and watch it (link_pull_request, watch_pull_request); merged is not done until ship.yml's run passes.",
);
