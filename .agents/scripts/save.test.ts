import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type TestContext, test } from "node:test";

const root = resolve(import.meta.dirname, "../..");

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "save-test-"));
  mkdirSync(join(dir, "gate"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
  const put = (file: string, text: string) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), text);
  };
  put("package.json", '{"type":"module"}');
  put(".gitignore", "node_modules/\n");
  for (const file of ["save.ts", "proof.ts", "review.ts"]) {
    put(`.agents/scripts/${file}`, readFileSync(join(root, ".agents/scripts", file), "utf8"));
  }
  put(
    ".agents/scripts/proof.ts",
    `import { trusted } from "./trusted/export.ts";
if (trusted !== true) throw new Error("Untrusted dependency");
${readFileSync(join(repo, ".agents/scripts/proof.ts"), "utf8")}`,
  );
  put(".agents/scripts/trusted/export.ts", 'export { trusted } from "./value.ts";');
  put(".agents/scripts/trusted/value.ts", "export const trusted = true;");
  put(".agents/scripts/index.ts", "");
  put("docs/note.md", "original\n");
  put("docs/deleted.md", "original\n");
  put("other.md", "unrelated\n");
  git("init", "-b", "main");
  git("config", "user.name", "Save test");
  git("config", "user.email", "save@example.invalid");
  git("config", "core.hooksPath", "/dev/null");
  git("add", ".");
  git("commit", "-m", "fixture");
  execFileSync("git", ["clone", "--bare", repo, join(dir, "remote")], { stdio: "pipe" });
  git("remote", "add", "origin", join(dir, "remote"));
  git("fetch", "origin", "main");
  git("switch", "-c", "work");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const script = (name: string, source: string) =>
    writeFileSync(join(bin, name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
  script("npm", "if(process.env.FAIL_CHECK) { console.error('fixture diagnostic tail'); process.exit(1); }");
  script(
    "git",
    `
    const {execFileSync} = require('node:child_process');
    const {writeFileSync} = require('node:fs');
    const args = process.argv.slice(2);
    if (args[0] === process.env.FAIL_GIT) { console.error('injected git failure'); process.exit(1); }
    if (args[0] === 'push') {
      writeFileSync(${JSON.stringify(join(dir, "commit"))}, execFileSync(${JSON.stringify(realGit)}, ['show', '--format=', '--name-status', 'HEAD']));
      process.exit(0);
    }
    try { process.stdout.write(execFileSync(${JSON.stringify(realGit)}, args, {stdio: ['ignore', 'pipe', 'pipe']})); }
    catch (err) { process.stderr.write(err.stderr); process.exit(err.status || 1); }
  `,
  );
  script(
    "gh",
    `
    const {appendFileSync} = require('node:fs');
    const args = process.argv.slice(2);
    appendFileSync(${JSON.stringify(join(dir, "gh.log"))}, JSON.stringify(args) + '\\n');
    const command = args.slice(0, 2).join(' ');
    if (command === process.env.FAIL_GH) { console.error('injected gh failure'); process.exit(1); }
    if (command === 'token generate') console.log('fake-token');
    if (command === 'issue view') console.log(JSON.stringify({state:'OPEN', title:'fixture', body:'fixture', comments:[]}));
    if (command === 'pr merge' && process.env.MERGE_FIXTURE) {
      require('node:child_process').execFileSync(${JSON.stringify(realGit)}, ['--git-dir', ${JSON.stringify(join(dir, "remote"))}, 'fetch', process.cwd(), 'HEAD:refs/heads/main'], {stdio:'pipe'});
    }
    if (command === 'run list') console.log('123 https://example.invalid/run/123');
    if (command === 'pr list' && process.env.EXISTING) console.log('https://example.invalid/pr/1');
    if (command === 'pr create') console.log('https://example.invalid/pr/1');
    if (command === 'pr view') console.log(process.env.MERGED ? 'MERGED' : 'OPEN');
    if (command === 'pr checks' && !process.env.MERGED) { console.error('check failed: fixture diagnostic tail'); process.exit(1); }
  `,
  );
  script(
    "claude",
    `console.log(JSON.stringify({structured_output: {summary:'blocked', findings:process.env.PASS_REVIEW ? [] : [{priority:1,title:'Gate weakened',file:'.agents/scripts/save.ts',line:1,body:'Must block'}]}}))`,
  );
  const home = join(dir, "home");
  mkdirSync(join(home, ".config/life-ai"), { recursive: true });
  writeFileSync(join(home, ".config/life-ai/app.pem"), "fixture");
  writeFileSync(join(home, ".config/life-ai/personal-terms"), "synthetic-private-marker");
  const run = (extra: Record<string, string> = {}, ...args: string[]) =>
    spawnSync(
      process.execPath,
      [join(repo, ".agents/scripts/save.ts"), "--work", "LAB.1.93", "-m", "fixture", ...args],
      {
        cwd: repo,
        encoding: "utf8",
        timeout: 20_000,
        env: {
          ...process.env,
          PERSONAL_TERMS: "synthetic-private-marker",
          LIFE_AI_GATE_TMP: join(dir, "gate"),
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          ...extra,
        },
      },
    );
  return { dir, repo, put, git, run };
}

const args = ["--issue", "96", "--proof", "Synthetic production smoke"];
test("refuses on main", (t) => {
  const f = fixture(t);
  f.git("switch", "main");
  assert.match(f.run({}, "docs/", ...args).stderr, /never from main/);
});
test("folder stages renames and deletions, reuses PR, trailers and match-head agree", (t) => {
  const f = fixture(t);
  f.git("mv", "docs/note.md", "docs/renamed.md");
  f.git("rm", "docs/deleted.md");
  const result = f.run({ EXISTING: "1" }, "docs/", ...args, "--no-wait");
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(join(f.dir, "gh.log"), "utf8");
  assert.match(calls, /"pr","edit"/);
  assert.doesNotMatch(calls, /"pr","create"/);
  assert.match(calls, /--match-head-commit/);
  assert.match(calls, new RegExp(f.git("rev-parse", "HEAD")));
  assert.match(calls, /Work: LAB.1.93/);
  assert.match(calls, /Agent:/);
  assert.match(calls, /Session:/);
  assert.match(readFileSync(join(f.dir, "commit"), "utf8"), /docs\/deleted.md/);
});
for (const surface of ["diff", "message", "body", "missing"])
  test(`personal scan refuses ${surface} before push`, (t) => {
    const f = fixture(t);
    f.put("docs/note.md", surface === "diff" ? "synthetic-private-marker" : "changed");
    const result = f.run(
      surface === "missing" ? { PERSONAL_TERMS: "" } : {},
      "docs/",
      ...args,
      ...(surface === "message"
        ? ["-m", "synthetic-private-marker"]
        : surface === "body"
          ? ["--proof", "synthetic-private-marker"]
          : []),
      "--no-wait",
    );
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /synthetic-private-marker/);
    assert.throws(() => readFileSync(join(f.dir, "commit")));
  });
test("check failure carries diagnostic tail", (t) => {
  const f = fixture(t);
  f.put("docs/note.md", "changed");
  assert.match(f.run({ FAIL_CHECK: "1" }, "docs/", ...args).stderr, /fixture diagnostic tail/);
});
test("merge wait precedes ship wait", (t) => {
  const f = fixture(t);
  f.put("docs/note.md", "changed");
  const result = f.run({ MERGED: "1", MERGE_FIXTURE: "1" }, "docs/", ...args);
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(join(f.dir, "gh.log"), "utf8");
  assert.ok(calls.indexOf('"pr","checks"') < calls.indexOf('"run","watch"'));
  assert.match(result.stdout, /Production check passed/);
});
