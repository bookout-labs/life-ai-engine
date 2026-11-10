import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const hook = resolve(".agents/hooks/orchestrator-rotation.ts");
const marker = "Life-AI-Session-Role: orchestrator";

function fixture(t: { after: (fn: () => void) => void }, provider: "claude" | "codex", prompt = marker) {
  const home = mkdtempSync(join(tmpdir(), "rotation-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home };
  const send = (event: Record<string, unknown>) => {
    const result = spawnSync(process.execPath, [hook, provider], {
      input: JSON.stringify({ session_id: "s", ...event }),
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout) : undefined;
  };
  if (prompt) send({ hook_event_name: "UserPromptSubmit", prompt });
  return { send, env };
}
const auto = { hook_event_name: "PreCompact", trigger: "auto" };
const stop = { hook_event_name: "Stop" };

test("Claude: automatic compaction is blocked, and the next stop asks for the handoff once", (t) => {
  const f = fixture(t, "claude");
  assert.equal(f.send(stop), undefined, "no handoff before the limit");
  assert.equal(f.send({ hook_event_name: "PreCompact", trigger: "manual" }), undefined, "manual compaction untouched");
  assert.equal(f.send(auto).decision, "block");
  assert.equal(f.send(auto).decision, "block", "every automatic attempt is blocked");
  const handoff = f.send(stop);
  assert.equal(handoff.decision, "block");
  assert.match(handoff.reason, /handoff\.ts write handoff/);
  assert.match(handoff.reason, /Always launch the successor.*pin it and unpin this one/s);
  assert.doesNotMatch(handoff.reason, /Leave pins unchanged/);
  assert.equal(f.send(stop), undefined, "delivered once");
});

test("Claude: the first stop past 350k asks for the handoff once, before compaction", (t) => {
  const f = fixture(t, "claude");
  const transcript = join(f.env.HOME, "t.jsonl");
  const call = (input: number, isSidechain = false) =>
    JSON.stringify({
      type: "assistant",
      isSidechain,
      message: { usage: { input_tokens: 2, cache_read_input_tokens: input, cache_creation_input_tokens: 0 } },
    });
  writeFileSync(transcript, `${call(360_000)}\n${call(349_000)}\n${call(390_000, true)}\n`);
  assert.equal(
    f.send({ ...stop, transcript_path: transcript }),
    undefined,
    "below 350k; a subagent's size does not count",
  );
  assert.equal(
    f.send({ ...stop, transcript_path: join(f.env.HOME, "missing.jsonl") }),
    undefined,
    "no transcript: the 400k backstop",
  );
  writeFileSync(transcript, `${call(349_000)}\n${call(350_000)}\n`);
  assert.match(f.send({ ...stop, transcript_path: transcript }).reason, /handoff\.ts write handoff/);
  assert.equal(f.send({ ...stop, transcript_path: transcript }), undefined, "delivered once");
});

test("Codex: automatic compaction runs, and that turn's stop asks for the handoff once", (t) => {
  const f = fixture(t, "codex");
  assert.equal(f.send(auto), undefined, "never blocked: blocking wedges Codex");
  const handoff = f.send(stop);
  assert.equal(handoff.decision, "block");
  assert.match(handoff.reason, /compacted this coordinator.*program store on disk/s);
  assert.equal(f.send(stop), undefined, "delivered once");
});

test("only the first prompt opts in; later prompts, workers and other sessions get nothing", (t) => {
  for (const provider of ["claude", "codex"] as const) {
    const late = fixture(t, provider, "Ordinary first prompt");
    late.send({ hook_event_name: "UserPromptSubmit", prompt: marker });
    late.send(auto);
    assert.equal(late.send(stop), undefined, `${provider}: a later marker cannot opt in`);
    const worker = fixture(t, provider);
    assert.equal(worker.send({ ...auto, agent_id: "worker" }), undefined, `${provider}: workers are excluded`);
    const unseen = fixture(t, provider, "");
    unseen.send(auto);
    assert.equal(unseen.send(stop), undefined, `${provider}: a session first seen later cannot opt in`);
  }
});

test("concurrent stops deliver the handoff once", async (t) => {
  const f = fixture(t, "claude");
  f.send(auto);
  const run = promisify(execFile);
  const results = await Promise.all(
    Array.from({ length: 6 }, () => {
      const child = run(process.execPath, [hook, "claude"], { env: f.env, encoding: "utf8" });
      child.child.stdin?.end(JSON.stringify({ session_id: "s", ...stop }));
      return child;
    }),
  );
  assert.equal(results.filter((r) => r.stdout.includes('"decision":"block"')).length, 1);
});

test("malformed input warns visibly and claims nothing", (t) => {
  const f = fixture(t, "claude");
  const result = spawnSync(process.execPath, [hook, "claude"], { input: "{not json", env: f.env, encoding: "utf8" });
  assert.match(JSON.parse(result.stdout).systemMessage, /Registration or handoff was not confirmed/);
});

test("both agents compact, and so hand off, at 400k", () => {
  assert.equal(JSON.parse(readFileSync(".claude/settings.json", "utf8")).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "400000");
  assert.match(readFileSync(".codex/config.toml", "utf8"), /^model_auto_compact_token_limit = 400000$/m);
});
