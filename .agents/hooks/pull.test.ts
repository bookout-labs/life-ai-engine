import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("session start fetches and reports without pulling a worktree branch", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pull-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
  writeFileSync(
    join(bin, "git"),
    `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(join(dir, "calls"))},JSON.stringify(a)+'\\n');if(a[0]==='rev-parse') console.log(${JSON.stringify(process.cwd())});if(a[0]==='rev-list') console.log('2');if(a[0]==='pull') process.exit(1);`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "node"), `#!${process.execPath}\nprocess.exit(0);`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "pull.ts")], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 commit/);
  const calls = readFileSync(join(dir, "calls"), "utf8");
  assert.match(calls, /"fetch","origin","main"/);
  assert.doesNotMatch(calls, /"pull"/);
});
