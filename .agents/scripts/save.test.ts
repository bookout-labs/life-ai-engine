import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type TestContext, test } from "node:test";

import { waitForMerge } from "./save-wait.ts";

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
  for (const file of ["save.ts", "save-wait.ts", "proof.ts", "review.ts"]) {
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
  put(".agents/skills/lab/SKILL.md", "original\n");
  put(".agents/skills/lab/nested/note.md", "original\n");
  put(".agents/other/note.md", "original\n");
  mkdirSync(join(repo, ".claude"));
  symlinkSync("../.agents/skills", join(repo, ".claude/skills"));
  mkdirSync(join(dir, "outside"));
  writeFileSync(join(dir, "outside/note.md"), "original\n");
  symlinkSync("../outside", join(repo, "external"));
  symlinkSync("../../outside", join(repo, ".claude/external"));
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
    if (command === 'pr view') console.log(JSON.stringify({state:process.env.MERGED ? 'MERGED' : 'OPEN', statusCheckRollup:['check','gate','secrets'].map(name => ({name,status:'COMPLETED',conclusion:process.env.MERGED ? 'SUCCESS' : 'FAILURE'}))}));
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
  const runFrom = (cwd: string, extra: Record<string, string>, ...args: string[]) =>
    spawnSync(
      process.execPath,
      [join(repo, ".agents/scripts/save.ts"), "--work", "LAB.1.93", "-m", "fixture", ...args],
      {
        cwd,
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
  const run = (extra: Record<string, string> = {}, ...args: string[]) => runFrom(repo, extra, ...args);
  return { dir, repo, put, git, run, runFrom };
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
  assert.ok(calls.indexOf('"pr","view"') < calls.indexOf('"run","watch"'));
  assert.match(result.stdout, /Production check passed/);
});

const check = (name: string, status = "COMPLETED", conclusion: string | null = "SUCCESS") => ({
  name,
  status,
  conclusion,
});
const passed = [check("check"), check("gate"), check("secrets")];

test("merge wait includes missing and pending checks and queue delay", async () => {
  const snapshots = [
    { state: "OPEN", statusCheckRollup: [] },
    { state: "OPEN", statusCheckRollup: [check("check"), check("secrets")] },
    { state: "OPEN", statusCheckRollup: [check("check"), check("secrets"), check("gate", "IN_PROGRESS", null)] },
    { state: "OPEN", statusCheckRollup: passed },
    { state: "MERGED", statusCheckRollup: passed },
  ];
  let pauses = 0;
  await waitForMerge(() => JSON.stringify(snapshots.shift()), "pr", {
    pause: async () => {
      pauses++;
    },
  });
  assert.equal(pauses, 4);
  assert.equal(snapshots.length, 0);
});
for (const name of ["check", "gate", "secrets"])
  test(`merge wait fails immediately when ${name} fails`, async () => {
    await assert.rejects(
      waitForMerge(
        () => JSON.stringify({ state: "OPEN", statusCheckRollup: [check(name, "COMPLETED", "FAILURE")] }),
        "pr",
        {
          pause: async () => {
            assert.fail("must not wait after failure");
          },
        },
      ),
      new RegExp(`${name} failed`),
    );
  });
test("merge wait times out even if all checks pass but the queue never merges", async () => {
  let elapsed = 0;
  await assert.rejects(
    waitForMerge(() => JSON.stringify({ state: "OPEN", statusCheckRollup: passed }), "pr", {
      now: () => elapsed,
      pause: async () => {
        elapsed += 5000;
      },
      timeoutMs: 30 * 60_000,
    }),
    /Timed out/,
  );
  assert.equal(elapsed, 30 * 60_000);
});

test("merge wait ignores superseded failed and canceled runs", async () => {
  await waitForMerge(
    () =>
      JSON.stringify({
        state: "MERGED",
        statusCheckRollup: [
          ...passed.map((c) => ({ ...c, startedAt: "2026-11-09T17:00:00Z" })),
          { ...check("gate", "COMPLETED", "FAILURE"), startedAt: "2026-11-09T16:00:00Z" },
          { ...check("secrets", "COMPLETED", "CANCELLED"), startedAt: "2026-11-09T16:00:00Z" },
        ],
      }),
    "pr",
    {
      pause: async () => {
        assert.fail("already merged with current checks successful");
      },
    },
  );
});

for (const target of ["../.agents/other", "../missing", "../../outside"]) {
  test(`saves retargeted alias to ${target}`, (t) => {
    const f = fixture(t);
    rmSync(join(f.repo, ".claude/skills"));
    symlinkSync(target, join(f.repo, ".claude/skills"));
    const result = f.run({}, ".claude/skills");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /proof|issue/i);
    assert.equal(f.git("show", ":.claude/skills"), target, result.stderr);
    assert.equal(f.git("diff", "--cached", "--name-status"), "M\t.claude/skills", result.stderr);
  });
}

test("saves a retargeted alias and edits under its new target together", (t) => {
  const f = fixture(t);
  rmSync(join(f.repo, ".claude/skills"));
  symlinkSync("../docs", join(f.repo, ".claude/skills"));
  f.put("docs/note.md", "edited\n");
  const result = f.run({}, ".claude/skills");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /proof|issue/i);
  assert.equal(f.git("diff", "--cached", "--name-status"), "M\t.claude/skills\nM\tdocs/note.md", result.stderr);
  assert.equal(f.git("show", ":docs/note.md"), "edited", result.stderr);
});

test("saves a tracked external link without staging its external target", (t) => {
  const f = fixture(t);
  rmSync(join(f.repo, ".claude/external"));
  symlinkSync("../../outside/note.md", join(f.repo, ".claude/external"));
  writeFileSync(join(f.dir, "outside/note.md"), "external edit\n");
  const result = f.run({}, ".claude/external");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /proof|issue/i);
  assert.equal(f.git("diff", "--cached", "--name-status"), "M\t.claude/external", result.stderr);
  assert.equal(f.git("show", ":.claude/external"), "../../outside/note.md", result.stderr);
});

for (const path of [
  ".claude/skills/lab/SKILL.md",
  ".claude/skills",
  ".claude/skills/",
  ".claude/skills/lab/",
  ".agents/skills/lab/SKILL.md",
  ".",
]) {
  test(`saves an edit named through ${path}`, (t) => {
    const f = fixture(t);
    f.put(".agents/skills/lab/SKILL.md", "edited\n");
    f.put("docs/note.md", "unrelated edit\n");
    const endToEnd = path === ".claude/skills/lab/SKILL.md";
    const result = f.run({}, path, ...(endToEnd ? [...args, "--no-wait"] : []));
    assert.equal(result.status, endToEnd ? 0 : 1, result.stderr);
    if (endToEnd) {
      assert.equal(f.git("show", "HEAD:.agents/skills/lab/SKILL.md"), "edited");
      return;
    }
    assert.match(result.stderr, /proof|issue/i);
    assert.equal(f.git("show", ":.agents/skills/lab/SKILL.md"), "edited", result.stderr);
    assert.equal(
      f.git("diff", "--cached", "--name-only"),
      path === "." ? ".agents/skills/lab/SKILL.md\ndocs/note.md" : ".agents/skills/lab/SKILL.md",
      result.stderr,
    );
  });
}

test("saves a new file through an absolute alias path", (t) => {
  const f = fixture(t);
  f.put(".agents/skills/lab/new.md", "new\n");
  const result = f.run({}, join(f.repo, ".claude/skills/lab/new.md"));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /proof|issue/i);
  assert.equal(f.git("diff", "--cached", "--name-status"), "A\t.agents/skills/lab/new.md", result.stderr);
});

for (const [deleted, path, expected] of [
  [".agents/skills/lab/SKILL.md", ".claude/skills/lab/SKILL.md", "D\t.agents/skills/lab/SKILL.md"],
  [".agents/skills/lab", ".claude/skills/lab", "D\t.agents/skills/lab/SKILL.md\nD\t.agents/skills/lab/nested/note.md"],
  [".agents/skills/lab/nested", ".claude/skills/lab/nested/note.md", "D\t.agents/skills/lab/nested/note.md"],
  [".agents/skills/lab", ".agents/skills/lab/SKILL.md", "D\t.agents/skills/lab/SKILL.md"],
  [".claude/skills", ".claude/skills", "D\t.claude/skills"],
] satisfies [string, string, string][]) {
  test(`saves deletion of ${deleted} named through ${path}`, (t) => {
    const f = fixture(t);
    rmSync(join(f.repo, deleted), { recursive: true });
    const result = f.run({}, path);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /proof|issue/i);
    assert.equal(f.git("diff", "--cached", "--name-status"), expected, result.stderr);
  });
}

test("saves both sides of a rename through the alias", (t) => {
  const f = fixture(t);
  f.put(".agents/skills/lab/renamed.md", "original\n");
  rmSync(join(f.repo, ".agents/skills/lab/SKILL.md"));
  const result = f.run({}, ".claude/skills/lab/SKILL.md", ".claude/skills/lab/renamed.md");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /proof|issue/i);
  assert.equal(
    f.git("diff", "--cached", "--name-status", "--no-renames"),
    "D\t.agents/skills/lab/SKILL.md\nA\t.agents/skills/lab/renamed.md",
    result.stderr,
  );
});

for (const path of ["../.claude/skills/lab/SKILL.md", "../.claude/skills", "../docs/note.md", "."]) {
  test(`saves from a subdirectory with ${path}`, (t) => {
    const f = fixture(t);
    const file = path.includes("skills") ? ".agents/skills/lab/SKILL.md" : "docs/note.md";
    f.put(file, "edited\n");
    const result = f.runFrom(join(f.repo, "docs"), {}, path);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /proof|issue/i);
    assert.equal(f.git("show", `:${file}`), "edited", result.stderr);
    assert.equal(f.git("diff", "--cached", "--name-only"), file, result.stderr);
  });
}

for (const path of ["external/note.md", "../../x"]) {
  test(`refuses ${path} before staging any named file`, (t) => {
    const f = fixture(t);
    f.put("docs/note.md", "edited\n");
    const result = f.run({}, "docs/note.md", path, ...args, "--no-wait");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /save: .*outside.*repository/i);
    assert.equal(f.git("diff", "--cached", "--name-only"), "", result.stderr);
  });
}

test("unchanged tracked symlink loop has nothing to save", (t) => {
  const f = fixture(t);
  symlinkSync("loop", join(f.repo, "loop"));
  f.git("add", "loop");
  f.git("commit", "-m", "loop");
  const result = f.run({}, "loop");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Nothing to save/);
});

test("ancestor symlink stages only the link", (t) => {
  const f = fixture(t);
  symlinkSync("..", join(f.repo, ".claude/root"));
  f.put("docs/note.md", "unrelated edit\n");
  const result = f.run({}, ".claude/root");
  assert.equal(result.status, 1, result.stderr);
  assert.equal(f.git("diff", "--cached", "--name-status"), "A\t.claude/root");
});
