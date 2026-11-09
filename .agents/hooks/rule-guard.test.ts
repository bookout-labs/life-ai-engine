import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { denyGlobs, protectedPaths } from "./rule-guard.ts";

const root = "/repo";
const home = "/home/u";
// The real deny list, so the hook and Claude's native rules can't drift apart.
const globs = denyGlobs(readFileSync(".claude/settings.json", "utf8"), root, home);
const blocked = (toolInput: unknown, cwd = root) => protectedPaths(toolInput, cwd, globs, home).length > 0;

const protectedFiles = [
  "AGENTS.md",
  "CLAUDE.md",
  "wiki/AGENTS.md",
  "projects/x/CLAUDE.md",
  ".claude/rules/code.md",
  `${home}/.claude/CLAUDE.md`,
  `${home}/.claude/rules/code.md`,
  `${home}/.claude/projects/p/memory/note.md`,
  `${home}/.codex/AGENTS.md`,
  `${home}/.codex/rules/default.rules`,
  `${home}/.codex/memories_1.sqlite`,
];

await test("anchors deny rules the way Claude does", () => {
  const settings = JSON.stringify({
    permissions: { deny: ["Edit(~/a/**)", "Edit(//etc/x)", "Edit(/b.md)", "Read(c)"] },
  });
  assert.deepEqual(denyGlobs(settings, root, home), [`${home}/a/**`, "/etc/x", `${root}/b.md`]);
});

for (const path of protectedFiles)
  await test(`blocks every agent's edit payload for ${path}`, () => {
    assert.ok(blocked({ file_path: path }), "Claude Write/Edit, Grok search_replace/write");
    assert.ok(blocked({ path }), "path key");
    assert.ok(blocked({ input: `*** Begin Patch\n*** Update File: ${path}\n*** End Patch` }), "Codex patch");
    assert.ok(blocked(`*** Begin Patch\n*** Add File: ${path}\n*** End Patch`), "Codex patch as a string");
    assert.ok(blocked({ command: `*** Begin Patch\n*** Delete File: ${path}\n*** End Patch` }), "patch delete");
    assert.ok(blocked({ command: `*** Update File: notes.md\n*** Move to: ${path}` }), "patch move");
  });

await test("allows ordinary edits, the registry and the catalog", () => {
  for (const path of [
    "notes.md",
    ".agents/rules.ts",
    "docs/skill-map.md",
    "wiki/AGENTS.md.bak",
    `${home}/.claude/settings.json`,
  ])
    assert.equal(blocked({ file_path: path }), false, path);
});

await test("expands home forms and judges paths from the repo root", () => {
  for (const path of ["~/.claude/rules/a.md", "$HOME/.codex/AGENTS.md", ["$", "{HOME}/.claude/CLAUDE.md"].join("")])
    assert.ok(blocked({ file_path: path }), path);
  assert.ok(blocked({ path: "../AGENTS.md" }, "/repo/docs"));
  assert.equal(blocked({ path: "../raw/a.md" }, "/repo/docs"), false);
});

await test("hook emits the platform denial protocol with repair instructions, using only Node built-ins", () => {
  const run = (toolInput: unknown) =>
    spawnSync(process.execPath, [".agents/hooks/rule-guard.ts"], {
      input: JSON.stringify({ cwd: process.cwd(), tool_name: "Write", tool_input: toolInput }),
      encoding: "utf8",
    });
  const denied = run({ file_path: "AGENTS.md" });
  assert.equal(denied.status, 0, denied.stderr);
  const output = JSON.parse(denied.stdout).hookSpecificOutput;
  assert.equal(output.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /entry in \.agents\/rules\.ts with trigger and a hook or check route/);
  assert.equal(run({ file_path: "notes.md" }).stdout, "");
  assert.doesNotMatch(readFileSync(".agents/hooks/rule-guard.ts", "utf8"), /from "(?!node:|\.\/)/);
});
