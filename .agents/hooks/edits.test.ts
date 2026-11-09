import assert from "node:assert/strict";
import { test } from "node:test";
import { editedPaths } from "./edits.ts";

await test("reads the edited file from each agent's tool input", () => {
  assert.deepEqual(editedPaths({ file_path: "/r/a.ts" }), ["/r/a.ts"]);
  assert.deepEqual(editedPaths({ path: "b.ts", contents: "x" }), ["b.ts"]);
  const patch = "*** Begin Patch\n*** Update File: c.ts\n@@\n-x\n+y\n*** Add File: d.md\n+hi\n*** End Patch";
  assert.deepEqual(editedPaths({ command: patch }), ["c.ts", "d.md"]);
});

await test("returns nothing for input without a file", () => {
  assert.deepEqual(editedPaths(undefined), []);
  assert.deepEqual(editedPaths({ command: "ls -la" }), []);
});
