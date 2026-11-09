import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CORE, denyGlobs, protectedPaths } from "./rule-guard.ts";

const root = "/repo";
const home = "/home/u";
// The real deny list, so the hook and Claude's native rules can't drift apart.
const globs = denyGlobs(CORE, root, home);
const blocked = (toolInput: unknown, cwd = root, tool = "Write") =>
  protectedPaths(tool, toolInput, cwd, globs, home).length > 0;

const protectedFiles = [
  "AGENTS.md",
  "CLAUDE.md",
  "wiki/AGENTS.md",
  ".claude/CLAUDE.md",
  ".codex/AGENTS.md",
  "a/.hidden/AGENTS.md",
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
  assert.deepEqual(denyGlobs(["Edit(~/a/**)", "Edit(//etc/x)", "Edit(/b.md)", "Read(c)"], root, home), [
    `${home}/a/**`,
    "/etc/x",
    `${root}/b.md`,
  ]);
});

for (const path of protectedFiles)
  await test(`blocks every agent's edit payload for ${path}`, () => {
    assert.ok(blocked({ file_path: path }), "Claude Write/Edit, Grok search_replace/write");
    assert.ok(blocked({ path }), "path key");
    assert.ok(blocked({ input: `*** Begin Patch\n*** Update File: ${path}\n*** End Patch` }), "Codex patch");
    assert.ok(blocked(`*** Begin Patch\n*** Add File: ${path}\n*** End Patch`), "Codex patch as a string");
    assert.ok(blocked({ command: `*** Begin Patch\n*** Delete File: ${path}\n*** End Patch` }), "patch delete");
    assert.ok(blocked({ command: `*** Update File: notes.md\n*** Move to: ${path}` }), "patch move");
    assert.ok(blocked({ file_path: "notes.md", edits: [{ file_path: path }] }), "nested MultiEdit path");
    for (const command of [
      `echo x > '${path}'`,
      `echo x >> "${path}"`,
      `echo x | tee '${path}'`,
      `sed -i '' 's/x/y/' '${path}'`,
      `cp a '${path}'`,
      `mv a '${path}'`,
      `rm '${path}'`,
    ]) {
      assert.ok(blocked({ cmd: command }, root, "exec_command"), `Codex shell: ${command}`);
      assert.ok(blocked({ command }, root, "Bash"), `shell: ${command}`);
    }
  });

await test("deleting a protected folder or a folder that holds one is blocked", () => {
  for (const command of [
    "rm -rf .claude/rules",
    `rm -rf ${home}/.claude/rules`,
    `rm -r ${home}/.claude/projects/p/memory`,
    `rm -rf ${home}/.claude`,
    `mv ${home}/.codex /tmp/x`,
    `rm -rf ${home}/.claude/projects/p`,
    `rm -rf ${home}/.claude/projects`,
    "cp notes.md .claude/rules",
    "cp -t .claude/rules notes.md",
    `mv --target-directory=${home}/.claude/rules a.md b.md`,
    `mv notes.md ${home}/.claude/rules/`,
    `install -m 644 x.md ${home}/.claude/projects/p/memory`,
  ])
    assert.ok(blocked({ cmd: command }, root, "exec_command"), command);
  for (const command of [
    "cp notes.md .claude",
    `touch ${home}/.claude`,
    "rm -rf build",
    "rm -rf .claude/skills/old",
    `rm -rf ${home}/.claude/projects/p/cache`,
  ])
    assert.equal(blocked({ cmd: command }, root, "exec_command"), false, command);
});

await test("deleting a folder that holds a tracked instruction file is blocked", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rule-guard-tree-")));
  spawnSync("git", ["-C", dir, "init", "-q"]);
  mkdirSync(join(dir, "wiki"));
  writeFileSync(join(dir, "wiki/AGENTS.md"), "x");
  writeFileSync(join(dir, "wiki/page.md"), "x");
  spawnSync("git", ["-C", dir, "add", "."]);
  const local = denyGlobs(CORE, dir, home);
  assert.ok(protectedPaths("exec_command", { cmd: "rm -rf wiki" }, dir, local, home).length);
  assert.equal(protectedPaths("exec_command", { cmd: "rm wiki/page.md" }, dir, local, home).length, 0);
  assert.equal(protectedPaths("exec_command", { cmd: "cp -r wiki /tmp/backup" }, dir, local, home).length, 0);
  assert.ok(protectedPaths("exec_command", { cmd: "mv wiki /tmp/gone" }, dir, local, home).length);
});

await test("shell reads and unrelated writes pass", () => {
  for (const command of [
    "cat AGENTS.md",
    "rg rule CLAUDE.md",
    "echo hi > notes.md",
    "node .agents/scripts/rules.ts --write",
  ])
    assert.equal(blocked({ cmd: command }, root, "exec_command"), false, command);
});

await test("allows ordinary edits, the registry and the catalog", () => {
  for (const path of [
    "notes.md",
    ".agents/rules.ts",
    "docs/skill-map.md",
    "wiki/AGENTS.md.bak",
    "wiki/NOTAGENTS.md",
    ".claude/rulesx/a.md",
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

await test(".claude/settings.json carries every built-in entry, so Claude and Grok enforce them natively", () => {
  const deny: string[] = JSON.parse(readFileSync(".claude/settings.json", "utf8")).permissions.deny;
  for (const rule of CORE) assert.ok(deny.includes(rule), rule);
});

await test("the built-in list holds even when settings drop it or can't be read", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rule-guard-")));
  const denied = (tool: string, toolInput: unknown) =>
    spawnSync(process.execPath, [".agents/hooks/rule-guard.ts"], {
      input: JSON.stringify({ cwd: dir, tool_name: tool, tool_input: toolInput }),
      encoding: "utf8",
    }).stdout.includes('"deny"');
  for (const settings of [undefined, "{not json", JSON.stringify({ permissions: { deny: ["Edit(notes.md)"] } })]) {
    if (settings) {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, ".claude/settings.json"), settings);
    }
    assert.ok(denied("Write", { file_path: "AGENTS.md" }), `edit, settings ${settings}`);
    assert.ok(denied("exec_command", { cmd: "echo x > wiki/CLAUDE.md" }), `shell, settings ${settings}`);
    assert.ok(denied("Write", { file_path: join(homedir(), ".codex/AGENTS.md") }), `global, settings ${settings}`);
    assert.equal(denied("Write", { file_path: "other.md" }), false);
  }
  assert.ok(denied("Write", { file_path: "notes.md" }), "a local extra entry applies too");
});
