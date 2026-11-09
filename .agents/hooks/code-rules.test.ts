import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import { context } from "./code-rules.ts";

await test("delivers code guidance on matching edits and wiki guidance on page edits", () => {
  const repo = resolve(import.meta.dirname, "../..");
  assert.match(context(repo, ["a.ts"]), /smallest TypeScript/);
  assert.match(context(repo, ["apps/server.ts"]), /current primary sources/);
  assert.match(context(repo, ["~/.life-ai/pages/people/test.md"]), /preserve attribution/);
  assert.equal(context(repo, ["image.png"]), "");
});

await test("delivers wiki guidance on scratch edits and CLI writes from any working directory", () => {
  const repo = resolve(import.meta.dirname, "../..");
  for (const path of [
    "~/.life-ai/pages/topics/test.md",
    "/home/test-user/.life-ai/pages/daily/test.md",
    "$HOME/.life-ai/pages/a.md",
  ])
    assert.match(context(repo, [path], repo, "", "/home/test-user"), /pages.ts/);
  for (const command of [
    "node .agents/scripts/pages.ts write daily/test",
    'node "/repo/.agents/scripts/pages.ts" save topics/test',
    "node /repo/.agents/scripts/pages.ts write topics/test",
  ])
    assert.match(context(repo, [], "/tmp", command), /pages.ts/);
  assert.equal(context(repo, [], repo, "node .agents/scripts/pages.ts read topics/test"), "");
  assert.equal(context(repo, ["wiki/people/test.md"]), "");
});

await test("native shell and string patch payloads deliver context through the hook", () => {
  const repo = resolve(import.meta.dirname, "../..");
  for (const tool_input of [
    { cmd: "node .agents/scripts/pages.ts write topics/test" },
    "*** Begin Patch\n*** Update File: ~/.life-ai/pages/topics/test.md\n*** End Patch",
  ]) {
    const result = spawnSync(process.execPath, [".agents/hooks/code-rules.ts"], {
      cwd: repo,
      input: JSON.stringify({ cwd: repo, tool_input }),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /pages.ts/);
  }
});
