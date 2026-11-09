import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { decision } from "./rule-guard.ts";

const cwd = "/repo";
const home = "/home/test-user";
const protectedPaths = [
  "AGENTS.md",
  "CLAUDE.md",
  ".agents/rules/code.md",
  "docs/skill-map.md",
  ".claude/rules/local.md",
  ".claude/CLAUDE.md",
  ".codex/AGENTS.md",
  `${home}/.claude/projects/project/memory/note.md`,
  `${home}/.claude/rules/code.md`,
  `${home}/.claude/CLAUDE.md`,
  `${home}/.codex/AGENTS.md`,
];
for (const path of protectedPaths) {
  await test(`blocks Write/Edit/MultiEdit/patch and Bash writes to ${path}`, () => {
    for (const tool of ["Write", "Edit", "MultiEdit"])
      assert.equal(decision(tool, { file_path: path }, cwd, home)?.permissionDecision, "deny");
    assert.equal(
      decision("apply_patch", { input: `*** Begin Patch\n*** Update File: ${path}\n*** End Patch` }, cwd, home)
        ?.permissionDecision,
      "deny",
    );
    for (const command of [
      `echo x > '${path}'`,
      `echo x >> "${path}"`,
      `echo x | tee '${path}'`,
      `sed -i '' 's/x/y/' '${path}'`,
      `cp a '${path}'`,
      `mv a '${path}'`,
      `rm '${path}'`,
    ])
      assert.equal(decision("Bash", { command }, cwd, home)?.permissionDecision, "deny", command);
  });
}
await test("allows regeneration only as a standalone command and allows ordinary edits and reads", () => {
  for (const command of [
    "node .agents/scripts/rules.ts --write",
    "cat AGENTS.md",
    "rg rules docs/skill-map.md",
    "echo hi > notes.md",
  ])
    assert.equal(decision("Bash", { command }, cwd, home), undefined, command);
  assert.equal(decision("Write", { file_path: ".agents/rules.ts" }, cwd, home), undefined);
  assert.equal(decision("Edit", { file_path: "notes.md" }, cwd, home), undefined);
  assert.equal(
    decision("Bash", { command: "node .agents/scripts/rules.ts --write; echo x > AGENTS.md" }, cwd, home)
      ?.permissionDecision,
    "deny",
  );
});
await test("normalizes paths, handles multiple edits and protects personal boundaries", () => {
  for (const path of ["./AGENTS.md", "/repo/a/../AGENTS.md", "~/.claude/rules/a.md", "$HOME/.codex/AGENTS.md"])
    assert.equal(decision("Edit", { path }, cwd, home)?.permissionDecision, "deny");
  assert.equal(decision("MultiEdit", { edits: [{ path: "AGENTS.md" }] }, cwd, home)?.permissionDecision, "deny");

  assert.equal(decision("Bash", { command: "rm wiki/notes.md" }, cwd, home), undefined);
  assert.equal(decision("Delete", { path: "daily/2026-11-08.md" }, cwd, home), undefined);
  assert.equal(decision("Bash", { command: "rm -rf /tmp/scratch build.log" }, cwd, home), undefined);
});
await test("hook emits the platform denial protocol and concrete repair instructions", () => {
  const result = spawnSync(process.execPath, [".agents/hooks/rule-guard.ts"], {
    input: JSON.stringify({ cwd, tool_name: "Write", tool_input: { file_path: "AGENTS.md" } }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /entry in \.agents\/rules\.ts with trigger and a hook or check route/);
});

await test("handles native Codex shell and patch payloads", () => {
  assert.equal(decision("exec_command", { cmd: "echo x > AGENTS.md" }, cwd, home)?.permissionDecision, "deny");
  assert.equal(
    decision("apply_patch", "*** Begin Patch\n*** Update File: AGENTS.md\n*** End Patch", cwd, home)
      ?.permissionDecision,
    "deny",
  );
  assert.equal(
    decision("apply_patch", "*** Begin Patch\n*** Update File: notes.md\n*** End Patch", cwd, home),
    undefined,
  );
});

await test("paths are judged from the repo root when the session is in a subfolder", () => {
  const root = "/repo";
  assert.equal(
    decision("Write", { path: "../AGENTS.md" }, "/repo/docs", "/home/test-user", root)?.permissionDecision,
    "deny",
  );
  assert.equal(decision("Write", { path: "../raw/a.md" }, "/repo/docs", "/home/test-user", root), undefined);
  assert.equal(decision("Write", { path: "notes.md" }, "/repo/docs", "/home/test-user", root), undefined);
});

await test("a patch that moves a file onto a protected path is blocked", () => {
  const command = "*** Begin Patch\n*** Update File: notes.md\n*** Move to: AGENTS.md\n*** End Patch";
  assert.equal(decision("apply_patch", { command }, "/repo", "/home/test-user", "/repo")?.permissionDecision, "deny");
});

await test("nested instruction files are protected too", () => {
  for (const path of ["wiki/AGENTS.md", "projects/x/CLAUDE.md"])
    assert.equal(decision("Write", { path }, "/repo", "/home/test-user", "/repo")?.permissionDecision, "deny", path);
});

await test("Codex memory and execpolicy rules are protected", () => {
  for (const path of ["/home/test-user/.codex/memories_1.sqlite", "/home/test-user/.codex/rules/default.rules"])
    assert.equal(decision("Write", { path }, "/repo", "/home/test-user", "/repo")?.permissionDecision, "deny", path);
});
