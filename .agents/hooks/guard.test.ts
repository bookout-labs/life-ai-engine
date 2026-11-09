import assert from "node:assert/strict";
import { test } from "node:test";
import { isBlocked } from "./guard.ts";

await test("blocks raw saves, even after && or ;", () => {
  for (const command of [
    'git commit -m "x"',
    "git push origin main",
    "cd ~/life-ai && git push",
    "git status; git commit -am wip",
    "gh pr merge 12 --merge",
  ]) {
    assert.equal(isBlocked(command), true, command);
  }
});

await test("allows reads, save.ts, and commands that only mention git push", () => {
  for (const command of [
    "git status",
    "git log --oneline",
    'grep -n "git push" .agents/scripts/save.ts',
    'node .agents/scripts/save.ts --work LAB.2.4 -m "tests" a.ts',
  ]) {
    assert.equal(isBlocked(command), false, command);
  }
});

await test("allows Claude's practice runs in its scratchpad", () => {
  assert.equal(isBlocked("cd /private/tmp/x/scratchpad/branch-lab && git commit -m y"), false);
});
