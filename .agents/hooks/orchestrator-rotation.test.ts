import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const hook = resolve(".agents/hooks/orchestrator-rotation.ts");
const marker = "Life-AI-Session-Role: orchestrator";
function fixture(t: { after: (fn: () => void) => void }, provider = "claude", prompt: string | null = marker) {
  const home = mkdtempSync(join(tmpdir(), "rotation-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const transcript = join(home, "transcript.jsonl");
  const env = { ...process.env, HOME: home, LIFE_AI_ROTATION_TOKENS: "100" };
  const event = {
    hook_event_name: "Stop",
    session_id: "test",
    transcript_path: transcript,
    cwd: process.cwd(),
    model: provider === "codex" ? "gpt-6.1-sol" : "claude-opus-5-5",
    permission_mode: "default",
    turn_id: "synthetic-turn",
    stop_hook_active: false,
  };
  const store = join(home, ".life-ai/orchestrate/life-ai-builds");
  mkdirSync(store, { recursive: true });
  mkdirSync(join(store, "briefs"));
  writeFileSync(
    join(store, "briefs/synthetic.md"),
    "task-new must report to destination-from-brief at private-report-from-brief",
  );
  writeFileSync(join(store, "preferences.md"), "Synthetic standing orders. Preserve existing jobs.");
  writeFileSync(
    join(store, "agents.json"),
    JSON.stringify({ build: { taskId: "task-new", next: "Report to destination-new", status: "running" } }),
  );
  writeFileSync(join(store, "current-handoff-slug.txt"), "handoff/synthetic-current\n");
  writeFileSync(
    join(store, "current-handoff-input.json"),
    JSON.stringify({
      header: {
        status: "synthetic",
        retiringThreadId: "synthetic-thread",
        blockers: [],
        nextAction: "Restore",
        detailPaths: [],
        jobReportPaths: ["private-report"],
      },
      programStore: store,
      state: "Synthetic stored state",
      standingOrders: "Restore synthetic orders",
      jobs: [{ taskId: "task-old", reportingTo: "destination-old", reportPath: "private-report", status: "running" }],
    }),
  );
  const write = (tokens = 100, prompt: unknown = marker, tail: unknown[] = []) => {
    const rows =
      provider === "codex"
        ? [
            { type: "session_meta", payload: { id: "test" } },
            {
              type: "response_item",
              payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
            },
          ]
        : [
            { type: "user", sessionId: "test", message: { content: prompt } },
            {
              type: "assistant",
              sessionId: "test",
              message: { usage: { input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
            },
          ];
    writeFileSync(transcript, [...rows, ...tail].map((row) => JSON.stringify(row)).join("\n"));
  };
  write();
  const f = {
    home,
    transcript,
    env,
    event,
    write,
    run: (overrides = {}, environment = env) => {
      const result = spawnSync(process.execPath, [hook, provider], {
        input: JSON.stringify({ ...event, ...overrides }),
        env: environment,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      if (!result.stdout) return undefined;
      try {
        return JSON.parse(result.stdout);
      } catch {
        return result.stdout;
      }
    },
  };
  if (prompt !== null) f.run({ hook_event_name: "UserPromptSubmit", prompt });
  return f;
}

test("threshold below, at and above uses the latest usage, never accumulated spend", (t) => {
  const f = fixture(t);
  f.write(99);
  assert.equal(f.run(), undefined);
  f.write(101, marker, [
    {
      type: "assistant",
      message: { usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } },
    },
  ]);
  assert.equal(f.run(), undefined);
  f.write(100);
  assert.equal(f.run().decision, "block");
  assert.equal(f.run(), undefined);
  const above = fixture(t);
  above.write(101);
  assert.equal(above.run().decision, "block");
  const cache = fixture(t);
  cache.write(0, marker, [
    {
      type: "assistant",
      message: { usage: { input_tokens: 10, cache_read_input_tokens: 60, cache_creation_input_tokens: 30 } },
    },
  ]);
  assert.equal(cache.run().decision, "block");
});

test("only the first native coordinator prompt opts in; workers and unrelated sessions fail open", (t) => {
  for (const prompt of ["worker", `quoted ${marker}`, ""]) {
    const f = fixture(t, "claude", prompt);
    f.run({ hook_event_name: "UserPromptSubmit", prompt: marker });
    f.write(200, marker);
    assert.equal(f.run(), undefined);
    assert.equal(f.run({ hook_event_name: "PreCompact", trigger: "auto" }), undefined);
  }
  const f = fixture(t);
  assert.equal(f.run({ agent_id: "worker" }), undefined);
  assert.equal(f.run({ session_id: "other" }), undefined);
  assert.equal(f.run().decision, "block");
});

test("manual compaction is untouched; automatic preservation repeats and Stop issues once", (t) => {
  for (const stopFirst of [false, true]) {
    const f = fixture(t);
    f.write(stopFirst ? 100 : 1);
    assert.equal(f.run({ hook_event_name: "PreCompact", trigger: "manual" }), undefined);
    if (stopFirst) assert.equal(f.run().decision, "block");
    const instructions = f.run({ hook_event_name: "PreCompact", trigger: "auto" });
    assert.match(instructions, /EVERY known active task id/);
    assert.equal(f.run({ hook_event_name: "PreCompact", trigger: "auto" }), instructions);
    if (!stopFirst) assert.equal(f.run().decision, "block");
    assert.equal(f.run(), undefined);
  }
});

test("missing or malformed transcript, event, usage and state warn visibly", (t) => {
  const f = fixture(t);
  rmSync(f.transcript);
  assert.match(f.run().systemMessage, /not confirmed/);
  for (const body of ["{broken", "null", JSON.stringify({ type: "assistant", message: { usage: "bad" } })]) {
    writeFileSync(f.transcript, body);
    assert.match(f.run().systemMessage, /not confirmed/);
  }
  for (const usage of [
    { input_tokens: "100" },
    { input_tokens: -1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    null,
  ]) {
    f.write(100, marker, [{ type: "assistant", message: { usage } }]);
    assert.match(f.run().systemMessage, /not confirmed/);
  }
  f.write();
  assert.match(f.run({ session_id: null }).systemMessage, /not confirmed/);
  assert.match(f.run({}, { ...f.env, LIFE_AI_ROTATION_TOKENS: "broken" }).systemMessage, /not confirmed/);
  assert.equal(f.run().decision, "block");
  const directory = join(f.home, ".life-ai/orchestrator-rotation");
  for (const file of readdirSync(directory)) {
    const path = join(directory, file);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    writeFileSync(path, "broken");
  }
  assert.match(f.run().systemMessage, /not confirmed/);
});

test("concurrent process hooks claim once and independent sessions still rotate", async (t) => {
  const f = fixture(t);
  const results = await Promise.all(
    Array.from(
      { length: 8 },
      () =>
        new Promise<string>((resolveResult, reject) => {
          const child = execFile(process.execPath, [hook, "claude"], { env: f.env }, (err, stdout) =>
            err ? reject(err) : resolveResult(stdout),
          );
          child.stdin?.end(JSON.stringify(f.event));
        }),
    ),
  );
  assert.equal(results.filter(Boolean).length, 1);
  f.write(100, marker, [
    { type: "user", sessionId: "other", message: { content: marker } },
    {
      type: "assistant",
      sessionId: "other",
      message: { usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    },
  ]);
  f.run({ session_id: "other", hook_event_name: "UserPromptSubmit", prompt: marker });
  assert.equal(f.run({ session_id: "other" }).decision, "block");
});

test("Codex uses its native auto boundary output and Stop recovery, with no fabricated usage", (t) => {
  const f = fixture(t, "codex");
  assert.equal(f.run(), undefined);
  assert.equal(f.run({ hook_event_name: "PreCompact", trigger: "manual" }), undefined);
  assert.equal(f.run({ session_id: "other", hook_event_name: "PreCompact", trigger: "auto" }), undefined);
  const output = f.run({ hook_event_name: "PreCompact", trigger: "auto" });
  assert.equal(output.continue, true);
  assert.match(output.systemMessage, /NOT live T3 status/);
  assert.deepEqual(f.run({ hook_event_name: "PreCompact", trigger: "auto" }), output);
  assert.equal(f.run().decision, "block");
  assert.equal(f.run(), undefined);
});

test("threshold is explicit and supported hooks preserve existing declarations", (t) => {
  const f = fixture(t);
  assert.equal(f.run({}, { ...f.env, LIFE_AI_ROTATION_TOKENS: "1000" }), undefined);
  const env = { ...f.env };
  Reflect.deleteProperty(env, "LIFE_AI_ROTATION_TOKENS");
  assert.equal(f.run({}, env), undefined);
  assert.match(f.run({ hook_event_name: "PreCompact", trigger: "auto" }, env), /standing orders/);
  for (const config of [".claude/settings.json", ".codex/hooks.json"]) {
    const hooks = JSON.parse(readFileSync(config, "utf8")).hooks;
    for (const event of ["UserPromptSubmit", "Stop", "PreCompact"]) {
      const groups = hooks[event].filter((group: { hooks: { command: string }[] }) =>
        group.hooks.some((hook) => hook.command.includes("orchestrator-rotation.ts")),
      );
      assert.equal(groups.length, 1);
      if (event === "PreCompact") assert.equal(groups[0].matcher, "auto");
    }
    assert.ok(
      hooks.Stop.some((group: { hooks: { command: string }[] }) =>
        group.hooks.some((hook) => hook.command.includes("stop-check.ts")),
      ),
    );
  }
});

test("a crashed transaction releases its lock and does not consume the rotation claim", async (t) => {
  const f = fixture(t);
  f.write(1);
  assert.equal(f.run(), undefined);
  const directory = join(f.home, ".life-ai/orchestrator-rotation");
  const database = join(directory, readdirSync(directory)[0] ?? "missing");
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1]);
    db.exec("BEGIN IMMEDIATE; INSERT INTO claims(event) VALUES ('Stop')");
    process.stdout.write("locked");
    setInterval(() => {}, 1000);
  `,
    database,
  ]);
  t.after(() => {
    child.kill("SIGKILL");
  });
  await once(child.stdout, "data");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  f.write(100);
  assert.equal(f.run().decision, "block");
  assert.equal(f.run(), undefined);
});

test("native first-prompt registration survives null transcripts and rejects later opt-in", (t) => {
  const f = fixture(t, "codex", null);
  assert.equal(f.run({ hook_event_name: "UserPromptSubmit", prompt: "worker", transcript_path: null }), undefined);
  assert.equal(f.run({ hook_event_name: "UserPromptSubmit", prompt: marker, transcript_path: null }), undefined);
  assert.equal(f.run({ hook_event_name: "PreCompact", trigger: "auto", transcript_path: null }), undefined);
});

test("native Codex opt-in does not depend on rollout user row formats", (t) => {
  const f = fixture(t, "codex");
  f.run({ hook_event_name: "UserPromptSubmit", prompt: marker, transcript_path: null });
  const output = f.run({ hook_event_name: "PreCompact", trigger: "auto", transcript_path: null });
  assert.ok(output, "registered native prompt must reach automatic preservation");
  assert.notEqual(output.continue, false, "a block alone cannot preserve state");
});

test("checkpoint is private, byte-exact, recoverable without a model turn and never asserts live status", (t) => {
  const f = fixture(t, "codex");
  const output = f.run({ hook_event_name: "PreCompact", trigger: "auto", transcript_path: null });
  const directory = join(f.home, ".life-ai/orchestrator-rotation");
  const path = join(directory, readdirSync(directory).find((name) => name.endsWith(".json")) ?? "missing");
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(Buffer.byteLength(output.systemMessage) <= 2000);
  assert.match(output.systemMessage, /NOT live T3 status/);
  const recovered = spawnSync(process.execPath, [hook, "read-checkpoint", path, "--full"], {
    env: f.env,
    encoding: "utf8",
  });
  assert.equal(recovered.status, 0, recovered.stderr);
  const snapshot = JSON.parse(recovered.stdout);
  for (const [name, contents] of Object.entries(snapshot.files)) {
    assert.equal(contents, readFileSync(join(f.home, ".life-ai/orchestrate/life-ai-builds", name), "utf8"));
  }
  assert.match(snapshot.files["briefs/synthetic.md"], /destination-from-brief/);
  assert.match(snapshot.files["agents.json"], /task-new/);
  assert.match(snapshot.files["agents.json"], /destination-new/);
  assert.match(snapshot.files["current-handoff-input.json"], /destination-old/);
  assert.equal(snapshot.files["current-handoff-slug.txt"], "handoff/synthetic-current\n");
  rmSync(join(f.home, ".life-ai/orchestrate"), { recursive: true });
  const restored = f.run({ hook_event_name: "UserPromptSubmit", prompt: "resume", transcript_path: null });
  assert.match(restored, /read-checkpoint/);
  assert.match(f.run().reason, /read-checkpoint/);
  writeFileSync(path, JSON.stringify({ ...snapshot, programStore: "tampered" }));
  const corrupt = spawnSync(process.execPath, [hook, "read-checkpoint", path, "--full"], {
    env: f.env,
    encoding: "utf8",
  });
  assert.equal(corrupt.status, 1);
  assert.equal(corrupt.stdout, "");
});

test("workers cannot register a parent session and absent prompt state never infers opt-in from transcripts", (t) => {
  for (const provider of ["claude", "codex"]) {
    const f = fixture(t, provider, null);
    f.run({ hook_event_name: "UserPromptSubmit", prompt: marker, agent_id: "worker", transcript_path: null });
    assert.equal(f.run({ hook_event_name: "PreCompact", trigger: "auto", agent_id: "worker" }), undefined);
    assert.equal(f.run(), undefined);
    f.run({ hook_event_name: "UserPromptSubmit", prompt: marker });
    assert.equal(f.run({ hook_event_name: "PreCompact", trigger: "auto" }), undefined);
    const fresh = fixture(t, provider, null);
    fresh.run({ hook_event_name: "UserPromptSubmit", prompt: "ordinary parent" });
    fresh.run({ hook_event_name: "UserPromptSubmit", prompt: marker, agent_id: "worker" });
    assert.equal(fresh.run({ hook_event_name: "PreCompact", trigger: "auto" }), undefined);
  }
});

test("automatic preservation is independent of missing, null and malformed transcripts", (t) => {
  const f = fixture(t);
  for (const transcript_path of [null, undefined]) {
    assert.match(
      f.run({ hook_event_name: "PreCompact", trigger: "auto", transcript_path }),
      /EVERY known active task id/,
    );
  }
  writeFileSync(f.transcript, `{broken\n${JSON.stringify({ type: "user", message: { content: marker } })}`);
  assert.match(f.run({ hook_event_name: "PreCompact", trigger: "auto" }), /EVERY known active task id/);
  assert.match(f.run().systemMessage, /not confirmed/);
  for (const provider of ["claude", "codex"]) {
    const fresh = fixture(t, provider);
    assert.equal(fresh.run({ hook_event_name: "PreCompact", trigger: "manual", transcript_path: null }), undefined);
    assert.equal(fresh.run({}, { ...fresh.env, LIFE_AI_ROTATION_TOKENS: "1000" }), undefined);
  }
});

test("concurrent native registrations retain a negative first decision and checkpoint retries converge", async (t) => {
  const f = fixture(t, "codex", null);
  async function concurrent(overrides: object) {
    return Promise.all(
      Array.from(
        { length: 4 },
        () =>
          new Promise<string>((resolveResult, reject) => {
            const child = execFile(process.execPath, [hook, "codex"], { env: f.env }, (error, stdout) =>
              error ? reject(error) : resolveResult(stdout),
            );
            child.stdin?.end(JSON.stringify({ ...f.event, ...overrides }));
          }),
      ),
    );
  }
  assert.deepEqual(await concurrent({ hook_event_name: "UserPromptSubmit", prompt: "ordinary first prompt" }), [
    "",
    "",
    "",
    "",
  ]);
  await concurrent({ hook_event_name: "UserPromptSubmit", prompt: marker });
  assert.equal(f.run({ hook_event_name: "PreCompact", trigger: "auto" }), undefined);
  f.run({ session_id: "coordinator", hook_event_name: "UserPromptSubmit", prompt: marker });
  const results = await concurrent({
    session_id: "coordinator",
    hook_event_name: "PreCompact",
    trigger: "auto",
    transcript_path: null,
  });
  assert.equal(results.filter(Boolean).length, 4);
  assert.equal(new Set(results).size, 1);
  assert.equal(
    readdirSync(join(f.home, ".life-ai/orchestrator-rotation")).filter((name) => name.endsWith(".json")).length,
    1,
  );
});

test("invalid private checkpoints warn without claiming successful preservation", (t) => {
  const f = fixture(t, "codex");
  const input = join(f.home, ".life-ai/orchestrate/life-ai-builds/current-handoff-input.json");
  const valid = readFileSync(input, "utf8");
  writeFileSync(input, "{}");
  const failed = f.run({ hook_event_name: "PreCompact", trigger: "auto" });
  assert.match(failed.systemMessage, /continuity preservation failed/);
  assert.doesNotMatch(failed.systemMessage, /[Rr]egistration|Private store snapshot/);
  assert.equal(f.run(), undefined);
  writeFileSync(input, valid);
  assert.equal(f.run({ hook_event_name: "PreCompact", trigger: "auto" }).continue, true);
});
