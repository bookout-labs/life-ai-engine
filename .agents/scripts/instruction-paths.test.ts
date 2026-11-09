import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { instructionPaths } from "./instruction-paths.ts";

function fixture(t: { after: (fn: () => void) => void }) {
  const repo = mkdtempSync(join(tmpdir(), "instruction-paths-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const put = (file: string, body = "") => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), body);
  };
  return { repo, put };
}

test("renaming a path named by a document fails with its source line", (t) => {
  const { repo, put } = fixture(t);
  put("docs/build.md", "Build.\nRun `node .agents/scripts/build.ts`.\n");
  put(".agents/scripts/build.ts");
  assert.deepEqual(instructionPaths(repo), []);
  renameSync(join(repo, ".agents/scripts/build.ts"), join(repo, ".agents/scripts/renamed.ts"));
  assert.deepEqual(instructionPaths(repo), ["docs/build.md:2: missing repository path .agents/scripts/build.ts"]);
});

test("checks bare filenames, local skill references, globs and root references", (t) => {
  const { repo, put } = fixture(t);
  put(".claude/skills/example/SKILL.md", "Use `snapshot.html`, `package.json` and `docs/*.md`.\n");
  put(".claude/skills/example/snapshot.html");
  put("package.json");
  put("docs/note.md");
  assert.deepEqual(instructionPaths(repo), []);
  rmSync(join(repo, ".claude/skills/example/snapshot.html"));
  rmSync(join(repo, "package.json"));
  assert.equal(instructionPaths(repo).length, 2);
});

test("covers agent maps, docs, skills and rules but leaves application prose alone", (t) => {
  const { repo, put } = fixture(t);
  for (const file of [
    "AGENTS.md",
    "CLAUDE.md",
    "docs/readme.md",
    ".agents/rules/note.md",
    ".agents/skills/a/SKILL.md",
    ".claude/rules/a.md",
    ".codex/skills/a/SKILL.md",
    ".codex/rules/a.md",
  ])
    put(file, "Read `docs/missing.md`.\n");
  put("apps/example.md", "Read `another/missing.md`.\n");
  assert.equal(instructionPaths(repo).length, 8);
});

test("ignores non-path code, external locations, URLs and placeholders", (t) => {
  const { repo, put } = fixture(t);
  put(
    "AGENTS.md",
    "`npm run check` `read <slug>` `--no-wait` `https://example.com/a.md` `~/.config/tool.json` `$HOME/a.md` `/today` `../outside.md` `.agents/{name}.ts`\n",
  );
  assert.deepEqual(instructionPaths(repo), []);
});
