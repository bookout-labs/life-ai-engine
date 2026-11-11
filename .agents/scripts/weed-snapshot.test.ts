import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const script = resolve(".agents/scripts/weed-snapshot.ts");
const verdicts = ["Keep", "Platform", "Reuse", "Script", "Delete", "Joe's call"];
const fixture = {
  target: "target <img>",
  wholeVerdict: "Keep <script>",
  runFigures: "Not measured <svg>",
  pieces: verdicts.map((verdict, index) => ({
    range: `file ${index + 1}`,
    lines: index + 1,
    what: `unique-piece-${index} <script>alert('x')</script> & "text" | next\nline`,
    failure: "none <iframe>",
    verdict,
    citation: "destination <a href=javascript:x>",
    loss: "nothing <img>",
  })),
  notAvailable: ["timing <svg>"],
};

test("plain node renders every piece once, escapes text and derives the bar and table together", () => {
  const dir = mkdtempSync(join(tmpdir(), "weed-snapshot-"));
  try {
    const input = join(dir, "pieces.json");
    writeFileSync(input, JSON.stringify(fixture));
    const run = spawnSync(process.execPath, [script, input], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const html = readFileSync(join(dir, "pieces.html"), "utf8");
    for (const [index, piece] of fixture.pieces.entries()) {
      assert.equal(html.split(`unique-piece-${index}`).length - 1, 1);
      assert.equal(run.stdout.split(`unique-piece-${index}`).length - 1, 1);
      assert.ok(run.stdout.includes(piece.verdict.replace("'", "&#39;")));
      assert.ok(html.includes(`data-lines="${piece.lines}"`));
    }
    assert.equal((html.match(/<article /g) ?? []).length, 6);
    assert.equal(run.stdout.trim().split("\n").length, 8);
    const barTotal = [...html.matchAll(/data-lines="(\d+)"/g)].reduce((sum, match) => sum + Number(match[1]), 0);
    assert.equal(barTotal, 21);
    assert.ok(html.includes(`data-total="${barTotal}"`));
    for (const tag of ["<script>", "<img>", "<iframe>", "<svg>", "<a href=javascript:x>"]) {
      assert.ok(!html.includes(tag));
      assert.ok(!run.stdout.includes(tag));
    }
    assert.ok(html.includes("&#60;script&#62;alert(&#39;x&#39;)&#60;/script&#62;"));
    assert.ok(run.stdout.includes("&#124; next<br>line"));
    const output = join(dir, "custom.html");
    const custom = spawnSync(process.execPath, [script, input, output], { encoding: "utf8" });
    assert.equal(custom.status, 0, custom.stderr);
    assert.equal(readFileSync(output, "utf8"), html);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTPS markdown links become safe anchors while other text stays escaped", () => {
  const dir = mkdtempSync(join(tmpdir(), "weed-links-"));
  try {
    const link = '[<img> & "issue"](https://example.com/?a=1&b="two")';
    const text = `${link} [unsafe](javascript:alert) [plain](http://example.com) <script>`;
    const input = join(dir, "links.json");
    writeFileSync(
      input,
      JSON.stringify({
        ...fixture,
        pieces: [
          {
            ...fixture.pieces[0],
            verdict: "Script",
            range: text,
            what: text,
            failure: text,
            citation: text,
            loss: text,
          },
        ],
      }),
    );
    const run = spawnSync(process.execPath, [script, input], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const html = readFileSync(join(dir, "links.html"), "utf8");
    const anchor =
      '<a href="https://example.com/?a=1&#38;b=&#34;two&#34;" target="_blank" rel="noopener">&#60;img&#62; &#38; &#34;issue&#34;</a>';
    assert.equal(html.split(anchor).length - 1, 6);
    assert.ok(html.includes("[unsafe](javascript:alert) [plain](http://example.com) &#60;script&#62;"));
    assert.ok(!html.includes("<img>"));
    assert.ok(!html.includes("<script>"));
    assert.equal((html.match(/<a /g) ?? []).length, 6);
    assert.ok(
      run.stdout.includes("[&#60;img&#62; &#38; &#34;issue&#34;](https://example.com/?a=1&#38;b=&#34;two&#34;)"),
    );
    assert.ok(!run.stdout.includes("<a "));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid input fails without writing a snapshot or printing a table", () => {
  const dir = mkdtempSync(join(tmpdir(), "weed-invalid-"));
  try {
    const input = join(dir, "bad.json");
    for (const value of [
      "{",
      JSON.stringify({ ...fixture, pieces: [] }),
      JSON.stringify({ ...fixture, pieces: [{ ...fixture.pieces[0], verdict: "maybe" }] }),
      JSON.stringify({ ...fixture, pieces: [{ ...fixture.pieces[0], lines: -1 }] }),
    ]) {
      writeFileSync(input, value);
      const run = spawnSync(process.execPath, [script, input], { encoding: "utf8" });
      assert.notEqual(run.status, 0);
      assert.equal(run.stdout, "");
      assert.throws(() => readFileSync(join(dir, "bad.html")));
    }
    const overwrite = spawnSync(process.execPath, [script, input, input], { encoding: "utf8" });
    assert.notEqual(overwrite.status, 0);
    const missing = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.notEqual(missing.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
