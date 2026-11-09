import assert from "node:assert/strict";
import { test } from "node:test";
import { stillUnsaved } from "./changes.ts";

await test("keeps only files untouched since the reply ended", () => {
  const leftUnsaved = { "a.ts": 1, "saved.ts": 2, "user-editing.md": 3 };
  const now = { "a.ts": 1, "user-editing.md": 4, "new.md": 5 };
  assert.deepEqual(stillUnsaved(leftUnsaved, now), ["a.ts"]);
});
