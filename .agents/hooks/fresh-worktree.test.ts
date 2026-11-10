import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

test("fresh checkout hooks enforce guards and register the first prompt without dependencies", (t) => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "fresh-hooks-")));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const repo = join(temporary, "checkout");
  const home = join(temporary, "home");
  mkdirSync(repo);
  mkdirSync(home);
  const archive = spawnSync("git", ["archive", process.env.HOOK_REPRO_REF ?? "HEAD"], { maxBuffer: 16 * 1024 * 1024 });
  assert.equal(archive.status, 0);
  assert.equal(spawnSync("tar", ["-x", "-C", repo], { input: archive.stdout }).status, 0);
  if (!process.env.HOOK_REPRO_REF) {
    cpSync(resolve(".agents/hooks"), join(repo, ".agents/hooks"), { recursive: true });
    cpSync(resolve(".agents/scripts"), join(repo, ".agents/scripts"), { recursive: true });
  }
  assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
  assert.equal(existsSync(join(repo, "node_modules")), false);
  const bin = join(temporary, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const failures: string[] = [];
  function run(name: string, input: object, args: string[] = []) {
    return spawnSync(process.execPath, [join(repo, `.agents/hooks/${name}.ts`), ...args], {
      cwd: repo,
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
      input: JSON.stringify({ cwd: repo, ...input }),
      encoding: "utf8",
    });
  }
  function check(name: string, result: ReturnType<typeof run>, correct: boolean) {
    const missing = result.stderr.includes("ERR_MODULE_NOT_FOUND");
    console.log(`${name}: exit=${result.status}, missing-module=${missing}, ${correct ? "PASS" : "FAIL"}`);
    if (!correct) failures.push(name);
  }
  const rule = run("rule-guard", { tool_name: "Write", tool_input: { file_path: "AGENTS.md" } });
  check("rule-guard", rule, rule.status === 2 || /"permissionDecision":"deny"/.test(rule.stdout));
  const ordinary = run("rule-guard", { tool_name: "Write", tool_input: { file_path: "notes.md" } });
  check("rule-guard/ordinary", ordinary, ordinary.status === 0 && ordinary.stdout === "");
  const malformed = run("rule-guard", { tool_name: "Write", tool_input: { file_path: 42 } });
  check(
    "rule-guard/malformed",
    malformed,
    malformed.status === 2 || /"permissionDecision":"deny"/.test(malformed.stdout),
  );
  const code = run("code-rules", { tool_name: "Edit", tool_input: { file_path: "sample.ts" } });
  check(
    "code-rules",
    code,
    code.status === 0 &&
      /Deliver lean-code and build guidance/.test(JSON.parse(code.stdout).hookSpecificOutput.additionalContext),
  );
  const outside = run("code-rules", { cwd: home, tool_name: "Bash", tool_input: { command: "ls" } });
  check("code-rules/non-git", outside, outside.status === 0 && outside.stdout === "");
  const trust = run("codex-trust", { tool_input: { target: { providerInstanceId: "codex" } } });
  check("codex-trust", trust, trust.status === 0 && /"permissionDecision":"deny"/.test(trust.stdout));
  const guard = run("guard", { tool_input: { command: "git push" } });
  check("guard", guard, /"permissionDecision":"deny"/.test(guard.stdout));
  const lint = run("lint-edit", { tool_input: { file_path: ".agents/hooks/guard.ts" } });
  check("lint-edit", lint, lint.status === 0 && /additionalContext/.test(lint.stdout));
  const start = run("turn-start", { session_id: "fresh" });
  check("turn-start", start, start.status === 0 && existsSync(join(repo, ".git/turn-start-fresh")));
  writeFileSync(join(repo, "fresh.txt"), "changed during the turn");
  const stop = run("stop-check", { session_id: "fresh" });
  check("stop-check", stop, stop.status === 0 && existsSync(join(repo, ".git/unsaved-fresh")));
  const pull = run("pull", {});
  check("pull", pull, pull.status === 0 && /systemMessage/.test(pull.stdout));
  for (const provider of ["claude", "codex"]) {
    const rotation = run(
      "orchestrator-rotation",
      {
        hook_event_name: "UserPromptSubmit",
        session_id: provider,
        prompt: "Life-AI-Session-Role: orchestrator",
        transcript_path: null,
      },
      [provider],
    );
    const directory = join(home, ".life-ai/orchestrator-rotation");
    let opted = 0;
    if (existsSync(directory))
      for (const name of readdirSync(directory)) {
        const db = new DatabaseSync(join(directory, name));
        opted += Number(db.prepare("SELECT opted FROM registration WHERE id=1").get()?.opted ?? 0);
        db.close();
      }
    check(
      `orchestrator-rotation/${provider}`,
      rotation,
      rotation.status === 0 && opted === (provider === "claude" ? 1 : 2),
    );
  }
  for (const provider of ["claude", "codex"]) {
    const compact = run(
      "orchestrator-rotation",
      { hook_event_name: "PreCompact", session_id: provider, trigger: "auto" },
      [provider],
    );
    const blockedCompaction = /"decision":"block"/.test(compact.stdout);
    check(
      `orchestrator-rotation/${provider}-auto`,
      compact,
      compact.status === 0 && blockedCompaction === (provider === "claude"),
    );
  }
  assert.deepEqual(failures, []);
});
