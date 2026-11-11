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
      { number: 1, title: "Weed .agents/scripts/a.ts", state: "CLOSED", body: "" },
      { number: 4, title: "Weed .agents/scripts/a.ts", state: "OPEN", body: "" },
      { number: 3, title: "Weed .agents/skills/weed", state: "CLOSED", body: "" },
    ],
    (path) => contents.get(path) ?? "",
  );
  assert.match(output, /\| .agents\/scripts\/a.ts \| 2 \| 2 \| #4 \|/);
  assert.match(output, /\| .agents\/skills\/weed\/SKILL.md \| 2 \| {2}\| #3 \|/);
  assert.match(output, /\| .github\/workflows\/check.yml \| 2 \| {2}\| not weeded \|/);
  assert.match(output, /\| node hook.ts \| {2}\| {2}\| not weeded \|/);
});

test("matches filenames and inventory rows, but not passing mentions", () => {
  const files = ["packages/core/a.ts", "packages/core/b.ts", "packages/core/c.ts", "packages/core/a.test.ts"];
  const output = table(
    files,
    [],
    [
      { number: 240, title: "Weed a.ts and b.ts", state: "CLOSED", body: "" },
      {
        number: 254,
        title: "Weed batch",
        state: "CLOSED",
        body: "| 1 | [packages/core/a.ts](url) | Keep |\nMention packages/core/c.ts in passing.",
      },
      {
        number: 258,
        title: "Weed another batch",
        state: "CLOSED",
        body: "| `packages/core/a.ts` | Keep |\n| packages/core/b.ts | Keep |",
      },
    ],
    () => "line\n",
  );
  assert.match(output, /\| packages\/core\/a.ts \| 1 \| 1 \| #258 \|/);
  assert.match(output, /\| packages\/core\/b.ts \| 1 \| {2}\| #258 \|/);
  assert.match(output, /\| packages\/core\/c.ts \| 1 \| {2}\| not weeded \|/);
  assert.doesNotMatch(output, /a\.test\.ts/);
});

test("a bare file name counts only in the folder the title names", () => {
  const files = [".agents/scripts/today.ts", "packages/core/today.ts", ".github/workflows/gate.yml"];
  const output = table(
    files,
    [],
    [
      { number: 245, title: "Weed .agents/scripts/today.ts and weekly.ts", state: "CLOSED", body: "" },
      { number: 248, title: "Weed .github/workflows gate and ship", state: "CLOSED", body: "" },
      { number: 254, title: "Weed packages/core money modules", state: "CLOSED", body: "| today.ts 1 to 9 | Keep |" },
    ],
    () => "line\n",
  );
  assert.match(output, /\| .agents\/scripts\/today.ts \| 1 \| {2}\| #245 \|/);
  assert.match(output, /\| packages\/core\/today.ts \| 1 \| {2}\| #254 \|/);
  assert.match(output, /\| .github\/workflows\/gate.yml \| 1 \| {2}\| #248 \|/);
});
