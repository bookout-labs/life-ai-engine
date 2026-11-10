// Lists merged, clean T3 worktrees idle for 48 hours. --remove opts into deletion.
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { root: { type: "string" }, remove: { type: "boolean", default: false } } });
const root = realpathSync(values.root ?? join(homedir(), ".t3/worktrees"));
const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8", stdio: "pipe", maxBuffer: 1 << 28 }).trim();
git("fetch", "origin", "+refs/heads/main:refs/remotes/origin/main");
const main = git("rev-parse", "origin/main");
const cutoff = Date.now() - 48 * 3600_000;

function idle(path: string): boolean {
  const stat = lstatSync(path);
  return stat.mtimeMs <= cutoff && (!stat.isDirectory() || readdirSync(path).every((child) => idle(join(path, child))));
}

function unused(path: string): boolean {
  const result = spawnSync("lsof", ["-nP", "-F", "p", "+D", path], { encoding: "utf8", timeout: 30_000 });
  if (result.error || result.stderr || (result.status !== 0 && result.status !== 1))
    throw new Error(`Cannot establish process safety for ${path}: ${result.error?.message ?? result.stderr}`);
  return result.status === 1 && !result.stdout;
}

function eligible(path: string): boolean {
  if (git("--no-optional-locks", "-C", path, "status", "--porcelain", "--untracked-files=all")) return false;
  if (git("-C", path, "ls-files", "--others", "--exclude-per-directory=.gitignore", "-z")) return false;
  const ignored = git("-C", path, "ls-files", "--others", "--ignored", "--exclude-standard", "-z");
  if (
    ignored
      .split("\0")
      .some((file) =>
        /(^|\/)(\.env(?:\.[^/]*)?|\.neon)(\/|$)|(^|\/)\.claude\/(settings\.local\.json|\.cc-writes)(\/|$)/.test(file),
      )
  )
    return false;
  const metadata = git("-C", path, "rev-parse", "--absolute-git-dir");
  if (!idle(path) || !idle(metadata)) return false;
  const head = git("-C", path, "rev-parse", "HEAD");
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", head, main]);
  if (ancestor.status !== 0) {
    if (ancestor.status !== 1) throw new Error(`Cannot establish merge safety for ${path}`);
    if (git("rev-list", "--merges", `${main}..${head}`)) return false;
    const patches = git("cherry", main, head).split("\n");
    if (!patches.every((patch) => patch.startsWith("- "))) return false;
  }
  return unused(path) && unused(metadata);
}

const [primary, ...linked] = git("worktree", "list", "--porcelain", "-z").split("\0\0");
for (const record of linked) {
  const fields = record.split("\0");
  const named = fields.find((field) => field.startsWith("worktree "))?.slice(9);
  if (!named || fields.some((field) => /^(locked|prunable)( |$)/.test(field))) continue;
  try {
    const path = realpathSync(named);
    const rel = relative(root, path);
    if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel) || primary?.startsWith(`worktree ${path}\0`))
      continue;
    if (!eligible(path)) continue;
    if (values.remove) {
      git("worktree", "remove", "--", path);
      console.log(`Removed ${path}`);
    } else console.log(`Would remove ${path}`);
  } catch (error) {
    console.error(`Skipped ${named}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
