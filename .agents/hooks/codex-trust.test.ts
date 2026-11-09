import assert from "node:assert/strict";
import { test } from "node:test";
import { toApprove, unrunnable } from "./codex-trust.ts";

const ours = "/repo/.codex/hooks.json";
const hook = (key: string, trustStatus: string, enabled = true, sourcePath = ours) => ({
  key,
  trustStatus,
  enabled,
  sourcePath,
  currentHash: `sha256:${key}`,
});
const hooks = [
  hook("ok", "trusted"),
  hook("new", "untrusted"),
  hook("edited", "modified"),
  hook("off", "untrusted", false),
  hook("elsewhere", "untrusted", true, "/other/.codex/hooks.json"),
  hook("main checkout", "untrusted", true, "/main/.codex/hooks.json"),
];

await test("approves only this repo's new or edited hooks that are switched on", () => {
  assert.deepEqual(
    toApprove(hooks, [ours]).map((h) => h.key),
    ["new", "edited"],
  );
});

await test("in a worktree, also approves the main checkout's hooks, which Codex actually reads", () => {
  assert.deepEqual(
    toApprove(hooks, [ours, "/main/.codex/hooks.json"]).map((h) => h.key),
    ["new", "edited", "main checkout"],
  );
});

await test("flags anything Codex would skip", () => {
  assert.deepEqual(unrunnable(hooks), ["new", "edited", "off", "elsewhere", "main checkout"]);
});
