import assert from "node:assert/strict";
import { test } from "node:test";
import { table } from "./weed-queue.ts";

test("prints paths, counts and newest matching issue", () => {
  const files = [
    ".agents/scripts/a.ts",
    ".agents/scripts/a.test.ts",
    ".agents/skills/weed/SKILL.md",
    ".github/workflows/check.yml",
  ];
  const contents = new Map(files.map((path) => [path, "one\ntwo\n"]));
  const output = table(
    files,
    ["node hook.ts"],
    [
      { number: 1, title: "Weed .agents/scripts/a.ts", state: "CLOSED" },
      { number: 4, title: "Weed .agents/scripts/a.ts", state: "OPEN" },
      { number: 3, title: "Weed .agents/skills/weed", state: "CLOSED" },
    ],
    (path) => contents.get(path) ?? "",
  );
  assert.match(output, /\| .agents\/scripts\/a.ts \| 2 \| 2 \| #4 \|/);
  assert.match(output, /\| .agents\/skills\/weed\/SKILL.md \| 2 \| {2}\| #3 \|/);
  assert.match(output, /\| .github\/workflows\/check.yml \| 2 \| {2}\| not weeded \|/);
  assert.match(output, /\| node hook.ts \| {2}\| {2}\| not weeded \|/);
});
