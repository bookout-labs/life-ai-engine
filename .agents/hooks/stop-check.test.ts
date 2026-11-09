import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

await test("stop records unsaved files and the next prompt reports them", (t) => {
  const repo = mkdtempSync(join(resolve(import.meta.dirname, "../../node_modules"), "life-stop-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", repo]);
  const run = (name: string) =>
    execFileSync(process.execPath, [resolve(import.meta.dirname, `${name}.ts`)], {
      cwd: repo,
      input: JSON.stringify({ cwd: repo, session_id: "test" }),
      encoding: "utf8",
    });
  run("turn-start");
  writeFileSync(join(repo, "note.md"), "new note");
  run("stop-check");
  assert.ok(JSON.parse(readFileSync(join(repo, ".git/unsaved-test"), "utf8"))["note.md"] > 0);
  assert.match(run("turn-start"), /note\.md/);
  assert.equal(run("turn-start"), "");
});
