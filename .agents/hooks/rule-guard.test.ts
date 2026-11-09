import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { denies } from "./rule-guard.ts";

const home = "/home/u";
const blocked = (toolInput: unknown, cwd = "/repo") => denies(toolInput, cwd, home) !== undefined;

await test("blocks each agent's edit of an instruction or memory file", () => {
  for (const path of [
    "AGENTS.md",
    "wiki/CLAUDE.md",
    ".claude/CLAUDE.md",
    ".claude/rules/code.md",
    "~/.claude/rules/code.md",
    `${home}/.claude/projects/p/memory/note.md`,
    `${home}/.codex/AGENTS.md`,
    `${home}/.codex/memories_1.sqlite`,
  ]) {
    assert.ok(blocked({ file_path: path }), `Claude or Grok: ${path}`);
    assert.ok(blocked({ path }), `path key: ${path}`);
    assert.ok(blocked({ file_path: "a.md", edits: [{ file_path: path }] }), `MultiEdit: ${path}`);
    assert.ok(blocked(`*** Begin Patch\n*** Update File: ${path}\n*** End Patch`), `Codex patch: ${path}`);
    assert.ok(blocked({ input: `*** Update File: a.md\n*** Move to: ${path}` }), `Codex move: ${path}`);
  }
  assert.ok(blocked({ path: "../AGENTS.md" }, "/repo/docs"));
});

await test("allows ordinary edits, the registry and the catalog", () => {
  for (const path of ["notes.md", ".agents/rules.ts", "docs/skill-map.md", "AGENTS.md.bak", "~/.claude/settings.json"])
    assert.equal(blocked({ file_path: path }), false, path);
});

await test("denies an edit it can't inspect", () => {
  assert.match(denies({ file_path: 42 }, "/repo") ?? "", /Cannot inspect/);
});

await test(".claude/settings.json denies the same places natively for Claude and Grok", () => {
  const deny: string[] = JSON.parse(readFileSync(".claude/settings.json", "utf8")).permissions.deny;
  for (const rule of [
    "Edit(**/AGENTS.md)",
    "Edit(**/CLAUDE.md)",
    "Edit(~/.claude/rules/**)",
    "Edit(~/.codex/AGENTS.md)",
  ])
    assert.ok(deny.includes(rule), rule);
});

await test("hook emits the platform denial protocol with repair instructions", () => {
  const run = (file_path: string) =>
    spawnSync(process.execPath, [".agents/hooks/rule-guard.ts"], {
      input: JSON.stringify({ cwd: process.cwd(), tool_name: "Write", tool_input: { file_path } }),
      encoding: "utf8",
    });
  const output = JSON.parse(run("AGENTS.md").stdout).hookSpecificOutput;
  assert.equal(output.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /entry in \.agents\/rules\.ts with trigger and a hook or check route/);
  assert.equal(run("notes.md").stdout, "");
});
