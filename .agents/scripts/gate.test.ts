import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

function fixture(t: TestContext, options: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gate-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
  const script = (name: string, body: string) =>
    writeFileSync(join(bin, name), `#!${process.execPath}\n${body}`, { mode: 0o755 });
  script("git", `console.log(process.argv[2]==='diff' ? (process.env.DIFF || '+safe') : 'safe');`);
  script(
    "gh",
    `const fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(join(dir, "calls"))},JSON.stringify(a)+'\\n');
    if(a[0]==='api') console.log(process.env.FOREIGN?'notes.md':'package.json');
    else if(a[0]==='issue'&&a[1]==='view') console.log(JSON.stringify({state:process.env.CLOSED?'CLOSED':'OPEN',title:'Synthetic issue',body:'Synthetic acceptance',comments:process.env.ROUNDS?Array(3).fill({body:'Review blocked (round 1/3)'}):[]}));`,
  );
  script(
    "claude",
    `if(process.env.CLAUDE_DOWN) process.exit(1);console.log(JSON.stringify({structured_output:{summary:'Reviewed',findings:[]}}));`,
  );
  script(
    "codex",
    `if(process.env.CODEX_DOWN) process.exit(1);const a=process.argv;require('node:fs').writeFileSync(a[a.indexOf('-o')+1],JSON.stringify({summary:'Reviewed',findings:process.env.BLOCK?[{priority:0,title:'bug',file:'a.ts',line:1,body:'b'}]:[]}));`,
  );
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "gate.ts")], {
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "bookout-labs/life-ai-engine",
      PR: "1",
      HEAD_SHA: "head",
      BASE_SHA: "base",
      BODY: "Board: #96\nProof: synthetic smoke\nAgent: claude-code",
      TITLE: "Safe title",
      PERSONAL_TERMS: "synthetic-private-marker",
      ...options,
    },
  });
  return { result, calls: readFileSync(join(dir, "calls"), "utf8") };
}
for (const options of [
  { FOREIGN: "1" },
  { CLOSED: "1" },
  { BODY: "Board: #96" },
  { DIFF: "+synthetic-private-marker" },
  { TITLE: "synthetic-private-marker" },
  { CODEX_DOWN: "1", CLAUDE_DOWN: "1" },
  { ROUNDS: "1" },
])
  test(`gate refuses ${Object.keys(options).join()}`, (t) => {
    const { result, calls } = fixture(t, options);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.doesNotMatch(result.stderr, /synthetic-private-marker/);
    if (options.ROUNDS) assert.doesNotMatch(calls, /\/reviews/);
  });
test("removed personal line passes and posts review receipt", (t) => {
  const { result, calls } = fixture(t, { DIFF: "-synthetic-private-marker\n+safe" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(calls, /Review: pass/);
});
test("Codex out of usage hands the review to Claude", (t) => {
  const { result, calls } = fixture(t, { CODEX_DOWN: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(calls, /Review: pass \(claude/);
});
test("a Codex blocker posts a blocked round", (t) => {
  const { result, calls } = fixture(t, { BLOCK: "1" });
  assert.equal(result.status, 1);
  assert.match(calls, /Review blocked \(round 1\/3, codex\)/);
});
test("Codex-built changes use Claude structured review", (t) => {
  const { result } = fixture(t, { BODY: "Board: #96\nProof: synthetic smoke\nAgent: codex" });
  assert.equal(result.status, 0, result.stderr);
});
