import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

await test("does not remind about files another actor has since changed", (t) => {
  const repo = mkdtempSync(join(resolve(import.meta.dirname, "../../node_modules"), "life-turn-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "note.md"), "changed");
  writeFileSync(join(repo, ".git/unsaved-test"), JSON.stringify({ "note.md": 1 }));
  const result = execFileSync(process.execPath, [resolve(import.meta.dirname, "turn-start.ts")], {
    cwd: repo,
    input: JSON.stringify({ cwd: repo, session_id: "test" }),
    encoding: "utf8",
  });
  assert.equal(result, "");
});
