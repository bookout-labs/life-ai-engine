import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { blocking, codexReview, parseReview, render, reviewerFor, roundsSinceRegroup } from "./review.ts";

const finding = { priority: 1, title: "Include the first element", file: "sum.ts", line: 3, body: "total([5]) is 0." };

test("reviewers come from a different family, with Codex as the fallback", () => {
  assert.equal(reviewerFor("claude-code"), "codex");
  assert.equal(reviewerFor("codex"), "claude");
  assert.equal(reviewerFor("grok"), "claude");
  for (const agent of ["user", "", "unknown", "constructor", "__proto__"]) assert.equal(reviewerFor(agent), "codex");
});

test("only P0 and P1 findings block a save", () => {
  const review = (...priorities: number[]) =>
    parseReview({ summary: "s", findings: priorities.map((priority) => ({ ...finding, priority })) });
  assert.equal(blocking(review()).length, 0);
  assert.equal(blocking(review(2, 3)).length, 0);
  assert.equal(blocking(review(3, 0)).length, 1);
  assert.equal(blocking(review(1, 1)).length, 2);
});

test("off-schema reviewer output fails instead of passing", () => {
  for (const value of [
    undefined,
    null,
    "No findings.",
    { findings: [] },
    { summary: "s" },
    { summary: "s", findings: [{ ...finding, priority: 4 }] },
    { summary: "s", findings: [{ ...finding, priority: "1" }] },
    { summary: "s", findings: [{ ...finding, priority: 1.5 }] },
    { summary: "s", findings: [{ ...finding, line: "3" }] },
    { summary: "s", findings: [null] },
  ])
    assert.throws(() => parseReview(value), /off-schema/, JSON.stringify(value));
});

test("renders findings with their priority and location", () => {
  assert.equal(
    render({ summary: "One bug.", findings: [finding] }),
    "One bug.\n- [P1] Include the first element — sum.ts:3\n  total([5]) is 0.",
  );
});

test("blocked rounds count from the last regroup", () => {
  const blocked = "Review blocked (round 1/3, codex) at abc";
  assert.equal(roundsSinceRegroup([]), 0);
  assert.equal(roundsSinceRegroup([blocked, "chatter", blocked, blocked]), 3);
  assert.equal(roundsSinceRegroup([blocked, blocked, blocked, "Regroup: structured output", blocked]), 1);
  assert.equal(roundsSinceRegroup(["quoting Review blocked (round 1/3)", " Regroup: no"]), 0);
});

test("Codex GraphQL review maps P0 and absent line and ignores old heads", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "codex-review-test-"));
  const previous = process.env.PATH;
  t.after(() => {
    process.env.PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.PATH = `${dir}:${previous}`;
  writeFileSync(join(dir, "package.json"), '{"type":"commonjs"}');
  const fixture = (oid: string) => {
    const data = {
      data: {
        repository: {
          pullRequest: {
            reviews: {
              nodes: [
                {
                  author: { login: "chatgpt-codex-connector" },
                  commit: { oid },
                  body: "Reviewed",
                  comments: { nodes: [{ path: "a.ts", line: null, body: "[P0] Synthetic bug" }] },
                },
              ],
            },
          },
        },
      },
    };
    writeFileSync(join(dir, "gh"), `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(data))});`, {
      mode: 0o755,
    });
  };
  fixture("head");
  const review = await codexReview("owner/repo", 1, "head", 0);
  assert.equal(review.findings[0]?.priority, 0);
  assert.equal(review.findings[0]?.line, 0);
  fixture("old");
  await assert.rejects(codexReview("owner/repo", 1, "head", 0), /No Codex review/);
});
