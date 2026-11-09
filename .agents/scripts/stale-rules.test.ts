import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { staleIssueLines, untilIssues } from "./stale-rules.ts";

test("finds every issue on a line that says until", () => {
  assert.deepEqual(untilIssues("Partial until #12 ships."), [{ line: 1, issue: 12 }]);
  assert.deepEqual(untilIssues("Until the split ([#7](https://x/issues/7)), use this repo."), [{ line: 1, issue: 7 }]);
  assert.deepEqual(untilIssues("#9: skip it until the balance is back"), [{ line: 1, issue: 9 }]);
  assert.deepEqual(untilIssues("Board #12 is done. See #4."), []);
  assert.deepEqual(untilIssues("a\nhold until #3 and #4"), [
    { line: 2, issue: 3 },
    { line: 2, issue: 4 },
  ]);
});

test("a rule tied to a closed issue fails with its location; an open one passes", () => {
  const path = join(mkdtempSync(join(tmpdir(), "stale-")), "rules.md");
  writeFileSync(path, "Keep it until #5.\nDetect until #6.\n");
  assert.deepEqual(
    staleIssueLines([path], (n) => n === 6),
    [`${path}:1: "until #5" names a closed issue; update the rule.`],
  );
});
