import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const hook = resolve(".agents/hooks/orchestrator-rotation.ts");
const marker = "Life-AI-Session-Role: orchestrator";
function fixture(t: { after: (fn: () => void) => void }, provider = "claude") {
  const home = mkdtempSync(join(tmpdir(), "rotation-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const transcript = join(home, "transcript.jsonl");
  const env = { ...process.env, HOME: home, LIFE_AI_ROTATION_TOKENS: "100" };
  const event = { hook_event_name: "Stop", session_id: "test", transcript_path: transcript };
  const write = (tokens = 100, prompt: unknown = marker, tail: unknown[] = []) => {
    const rows =
      provider === "codex"
        ? [
            { type: "session_meta", payload: { id: "test" } },
            { type: "event_msg", payload: { type: "user_message", message: prompt } },
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
  return {
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
      return result.stdout ? JSON.parse(result.stdout) : undefined;
    },
  };
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

test("only the first real coordinator prompt opts in; workers and unrelated sessions fail open", (t) => {
  const f = fixture(t);
  for (const prompt of ["worker", `quoted ${marker}`, ""]) {
    f.write(200, prompt, [{ type: "user", message: { content: marker } }]);
    assert.equal(f.run(), undefined);
    assert.equal(f.run({ hook_event_name: "PreCompact", trigger: "auto" }), undefined);
  }
  f.write();
  assert.equal(f.run({ agent_id: "worker" }), undefined);
  assert.equal(f.run({ session_id: "other" }), undefined);
  f.write(100, [{ type: "text", text: marker }]);
  assert.equal(f.run().decision, "block");
});

test("manual compaction is untouched; automatic guard and Stop each issue once", (t) => {
  for (const stopFirst of [false, true]) {
    const f = fixture(t);
    f.write(stopFirst ? 100 : 1);
    assert.equal(f.run({ hook_event_name: "PreCompact", trigger: "manual" }), undefined);
    if (stopFirst) assert.equal(f.run().decision, "block");
    assert.equal(f.run({ hook_event_name: "PreCompact", trigger: "auto" }).decision, "block");
    assert.equal(f.run({ hook_event_name: "PreCompact", trigger: "auto" }), undefined);
    if (!stopFirst) assert.equal(f.run().decision, "block");
    assert.equal(f.run(), undefined);
  }
});

test("missing or malformed transcript, event, usage and state fail open", (t) => {
  const f = fixture(t);
  rmSync(f.transcript);
  assert.equal(f.run(), undefined);
  for (const body of ["{broken", "null", JSON.stringify({ type: "assistant", message: { usage: "bad" } })]) {
    writeFileSync(f.transcript, body);
    assert.equal(f.run(), undefined);
  }
  for (const usage of [
    { input_tokens: "100" },
    { input_tokens: -1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    null,
  ]) {
    f.write(100, marker, [{ type: "assistant", message: { usage } }]);
    assert.equal(f.run(), undefined);
  }
  f.write();
  assert.equal(f.run({ session_id: null }), undefined);
  assert.equal(f.run({}, { ...f.env, LIFE_AI_ROTATION_TOKENS: "broken" }), undefined);
  assert.equal(f.run().decision, "block");
  const directory = join(f.home, ".life-ai/orchestrator-rotation");
  for (const file of readdirSync(directory)) {
    const path = join(directory, file);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    writeFileSync(path, "broken");
  }
  assert.equal(f.run(), undefined);
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
  assert.equal(f.run({ session_id: "other" }).decision, "block");
});

test("Codex uses its native auto boundary output and Stop recovery, with no fabricated usage", (t) => {
  const f = fixture(t, "codex");
  assert.equal(f.run(), undefined);
  assert.equal(f.run({ hook_event_name: "PreCompact", trigger: "manual" }), undefined);
  assert.equal(f.run({ session_id: "other", hook_event_name: "PreCompact", trigger: "auto" }), undefined);
  const output = f.run({ hook_event_name: "PreCompact", trigger: "auto" });
  assert.equal(output.continue, false);
  assert.match(output.stopReason, /current user\/session authorization/);
  assert.equal(f.run({ hook_event_name: "PreCompact", trigger: "auto" }), undefined);
  assert.equal(f.run().decision, "block");
  assert.equal(f.run(), undefined);
});

test("threshold is explicit and supported hooks preserve existing declarations", (t) => {
  const f = fixture(t);
  assert.equal(f.run({}, { ...f.env, LIFE_AI_ROTATION_TOKENS: "1000" }), undefined);
  const env = { ...f.env };
  Reflect.deleteProperty(env, "LIFE_AI_ROTATION_TOKENS");
  assert.equal(f.run({}, env), undefined);
  assert.equal(f.run({ hook_event_name: "PreCompact", trigger: "auto" }, env).decision, "block");
  for (const config of [".claude/settings.json", ".codex/hooks.json"]) {
    const hooks = JSON.parse(readFileSync(config, "utf8")).hooks;
    for (const event of ["Stop", "PreCompact"]) {
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
