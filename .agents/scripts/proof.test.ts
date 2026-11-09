import assert from "node:assert/strict";
import { test } from "node:test";
import { added, agentOf, boardNumber, kindOf, leaks, missing, requirements } from "./proof.ts";

test("engine path allowlist and requirements", () => {
  for (const p of ["apps/a.ts", "packages/a.ts", "db/a.sql", ".agents/scripts/a.ts", "t3.json", ".mcp.json"]) {
    assert.equal(kindOf(p), "code");
    assert.deepEqual(requirements([p]), { proof: true });
    assert.equal(missing([p], "Board: #96").length, 1);
  }
  for (const p of ["docs/a.md", ".claude/skills/a.md", "AGENTS.md"]) {
    assert.equal(kindOf(p), "system");
    assert.deepEqual(missing([p], "Board: #96"), []);
  }
  for (const p of ["wiki/a.md", "INDEX.md", "notes.md", "raw/a.pdf"]) {
    assert.equal(kindOf(p), undefined);
    assert.match(missing([p], "Board: #96").join(), /Not engine/);
  }
  assert.equal(missing(["package.json"], "Proof: synthetic proof").length, 1);
  assert.deepEqual(missing(["package.json"], "Board: #96\nProof: synthetic proof"), []);
});
test("trailers parse exact lines", () => {
  assert.equal(agentOf("Agent: codex"), "codex");
  assert.equal(agentOf(""), "unknown");
  assert.equal(boardNumber("Board: #0"), undefined);
});
test("only additions count and scan never echoes input", () => {
  assert.equal(added("--- a\n+++ b\n-private-marker\n+safe"), "safe");
  assert.equal(added("--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+++ secret-marker"), "++ secret-marker");
  assert.equal(leaks(["SAFE\nprivate-marker"], "private-marker"), 1);
  for (const terms of ["", "# comment", "["])
    assert.throws(
      () => leaks(["text"], terms),
      (err) => err instanceof Error && !err.message.includes("text"),
    );
});
