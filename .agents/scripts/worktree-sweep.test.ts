import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const script = resolve(import.meta.dirname, "worktree-sweep.ts");
test("dry run and repeated removal preserve primary, dirty, unmerged, recent and busy worktrees", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sweep-test-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "primary");
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "pipe" });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git("config", "user.name", "Sweep fixture");
  git("config", "user.email", ["sweep", "example.invalid"].join("@"));
  git("config", "core.hooksPath", "/dev/null");
  writeFileSync(join(repo, "note"), "base");
  writeFileSync(
    join(repo, ".gitignore"),
    "node_modules/\n.env\n.env.*\n.neon\n.claude/\napps/mcp/worker-configuration.d.ts\n",
  );
  git("add", ".");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  const remote = join(dir, "remote");
  execFileSync("git", ["clone", "--bare", repo, remote], { stdio: "pipe" });
  git("remote", "add", "origin", remote);
  git("fetch", "origin");
  const names = [
    "ancestry",
    "patch",
    "dirty",
    "untracked",
    "generated",
    "env",
    "env-local",
    "neon",
    "unmerged",
    "recent",
    "busy",
    "metadata",
    "user-ignore",
    "claude-settings",
    "claude-writes",
    "locked",
  ];
  for (const name of names) git("worktree", "add", "-b", name, join(dir, name));
  const change = (name: string, text: string) => {
    writeFileSync(join(dir, name, "note"), text);
    git("-C", join(dir, name), "add", ".");
    git("-C", join(dir, name), "commit", "-m", name);
  };
  change("patch", "same patch");
  writeFileSync(join(repo, "note"), "same patch");
  git("add", ".");
  git("commit", "-m", "independently applied patch");
  execFileSync("git", ["--git-dir", remote, "fetch", repo, "main:main"], { stdio: "pipe" });
  assert.equal(git("rev-parse", "origin/main"), base);
  change("unmerged", "unmerged patch");
  writeFileSync(join(dir, "dirty/note"), "dirty");
  writeFileSync(join(dir, "untracked/new"), "untracked");
  mkdirSync(join(dir, "generated/node_modules"));
  writeFileSync(join(dir, "generated/node_modules/package.json"), "{}");
  mkdirSync(join(dir, "generated/apps/mcp"), { recursive: true });
  writeFileSync(join(dir, "generated/apps/mcp/worker-configuration.d.ts"), "generated");
  writeFileSync(join(dir, "env/.env"), "fixture");
  mkdirSync(join(dir, "env-local/nested"));
  writeFileSync(join(dir, "env-local/nested/.env.local"), "fixture");
  writeFileSync(join(dir, "neon/.neon"), "fixture");
  writeFileSync(join(dir, "excludes"), "private-file\n.claude/\n");
  git("config", "core.excludesFile", join(dir, "excludes"));
  writeFileSync(join(dir, "user-ignore/private-file"), "private");
  for (const name of ["claude-settings", "claude-writes"]) mkdirSync(join(dir, name, ".claude"));
  writeFileSync(join(dir, "claude-settings/.claude/settings.local.json"), "fixture");
  mkdirSync(join(dir, "claude-writes/.claude/.cc-writes"));
  writeFileSync(join(dir, "claude-writes/.claude/.cc-writes/note"), "fixture");
  git("worktree", "lock", join(dir, "locked"));
  const old = new Date(Date.now() - 49 * 3600_000);
  const age = (path: string) => {
    if (lstatSync(path).isDirectory()) for (const child of readdirSync(path)) age(join(path, child));
    utimesSync(path, old, old);
  };
  for (const name of names.filter((name) => name !== "recent")) {
    age(join(dir, name));
    age(git("-C", join(dir, name), "rev-parse", "--absolute-git-dir"));
  }
  writeFileSync(join(git("-C", join(dir, "metadata"), "rev-parse", "--absolute-git-dir"), "activity"), "recent");
  const busy = spawn(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], {
    cwd: join(dir, "busy"),
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => busy.kill());
  await new Promise<void>((resolve) => busy.stdout.once("data", () => resolve()));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, "--root", dir, ...args], { cwd: repo, encoding: "utf8" });
  const dry = run();
  assert.equal(dry.status, 0, dry.stderr);
  const expected = [join(dir, "ancestry"), join(dir, "patch"), join(dir, "generated")];
  assert.deepEqual(dry.stdout.trim().split("\n").sort(), expected.map((path) => `Would remove ${path}`).sort());
  for (const name of names) assert.ok(existsSync(join(dir, name)));
  const removed = run("--remove");
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(removed.stdout.trim().split("\n").sort(), expected.map((path) => `Removed ${path}`).sort());
  for (const name of names)
    assert.equal(existsSync(join(dir, name)), !["ancestry", "patch", "generated"].includes(name), name);
  assert.ok(existsSync(repo));
  const repeat = run("--remove");
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(repeat.stdout, "");
});
