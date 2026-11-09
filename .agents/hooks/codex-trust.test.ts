import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { toApprove, unrunnable } from "./codex-trust.ts";

const ours = "/repo/.codex/hooks.json";
const hook = (key: string, trustStatus: string, enabled = true, sourcePath = ours) => ({
  key,
  trustStatus,
  enabled,
  sourcePath,
  currentHash: `sha256:${key}`,
});
const hooks = [
  hook("ok", "trusted"),
  hook("new", "untrusted"),
  hook("edited", "modified"),
  hook("off", "untrusted", false),
  hook("elsewhere", "untrusted", true, "/other/.codex/hooks.json"),
];

await test("approves only this repo's new or edited hooks that are switched on", () => {
  assert.deepEqual(
    toApprove(hooks, ours).map((h) => h.key),
    ["new", "edited"],
  );
});

await test("flags anything Codex would skip", () => {
  assert.deepEqual(unrunnable(hooks), ["new", "edited", "off", "elsewhere"]);
});

function fixture(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "codex-trust-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const main = join(dir, "main");
  const worktree = join(dir, "worker");
  mkdirSync(main);
  execFileSync("git", ["init", "-q", main]);
  execFileSync("git", ["-C", main, "worktree", "add", "--orphan", "-b", "worker", worktree], { stdio: "pipe" });
  const declaration = {
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "node rotation.ts codex" }] }] },
  };
  for (const repo of [main, worktree]) {
    mkdirSync(join(repo, ".codex"));
    writeFileSync(join(repo, ".codex/hooks.json"), JSON.stringify(declaration));
  }
  const mergeConfig = () => {
    execFileSync("git", ["-C", main, "add", ".codex/hooks.json"]);
    const tree = execFileSync("git", ["-C", main, "write-tree"], { encoding: "utf8" }).trim();
    const commit = execFileSync(
      "git",
      [
        "-C",
        main,
        "-c",
        "user.name=Fixture",
        "-c",
        `user.email=${["fixture", "example.invalid"].join("@")}`,
        "commit-tree",
        tree,
      ],
      { input: "fixture\n", encoding: "utf8" },
    ).trim();
    execFileSync("git", ["-C", main, "update-ref", "refs/remotes/origin/main", commit]);
  };
  mergeConfig();
  const source = join(main, ".codex/hooks.json");
  const state = join(dir, "rpc.json");
  const entry = {
    ...hook(`${source}:user_prompt_submit:0:0`, "untrusted", true, source),
  };
  const set = (hooks = [entry], extra = {}) => writeFileSync(state, JSON.stringify({ hooks, writes: [], ...extra }));
  set();
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "codex"),
    `#!${process.execPath}
const fs = require('node:fs');
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (!m.id) return;
  const s = JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_STATE, 'utf8'));
  let result = {};
  if (m.method === 'hooks/list') {
    result = {data: [{hooks: s.hooks}], ...s.response};
    if (s.editSource) fs.appendFileSync(s.editSource, ' ');
  }
  if (m.method === 'config/value/write') {
    s.writes.push(m.params);
    if (!s.ignoreWrites) for (const h of s.hooks) if (m.params.value[h.key]?.trusted_hash === h.currentHash) h.trustStatus = 'trusted';
    if (s.changeHashOnWrite) for (const h of s.hooks) h.currentHash = "changed-after-approval";
    fs.writeFileSync(process.env.FAKE_CODEX_STATE, JSON.stringify(s));
  }
  process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
});
`,
    { mode: 0o755 },
  );
  const run = () => {
    const result = spawnSync(process.execPath, [resolve(".agents/hooks/codex-trust.ts")], {
      cwd: worktree,
      input: JSON.stringify({ cwd: worktree, tool_input: { target: { providerInstanceId: "codex" } } }),
      env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, FAKE_CODEX_STATE: state },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const writes = () => JSON.parse(readFileSync(state, "utf8")).writes;
  return { main, worktree, source, entry, set, run, writes, mergeConfig };
}

await test("stale primary hooks already trusted allow delegation with visible context and no approval", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.main, ".codex/hooks.json"), `${readFileSync(f.source, "utf8")}\n`);
  f.set([{ ...f.entry, trustStatus: "trusted" }]);
  const output = JSON.parse(f.run());
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
  assert.match(output.systemMessage, /git -C .* pull --ff-only/);
  assert.ok(output.systemMessage.includes(f.main));
  assert.match(output.systemMessage, /hooks declared on main but missing from the primary.*inactive/i);
  assert.equal(output.hookSpecificOutput.additionalContext, output.systemMessage);
  assert.deepEqual(f.writes(), []);
});

await test("missing origin/main approves nothing but still allows trusted hooks with a warning", (t) => {
  const f = fixture(t);
  execFileSync("git", ["-C", f.main, "update-ref", "-d", "refs/remotes/origin/main"]);
  f.set([{ ...f.entry, trustStatus: "trusted" }]);
  const output = JSON.parse(f.run());
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
  assert.match(output.systemMessage, /pull --ff-only/);
  assert.deepEqual(f.writes(), []);
});

await test("a malformed hook from another source cannot block trusted project hooks", (t) => {
  const f = fixture(t);
  f.set([
    { ...f.entry, trustStatus: "trusted" },
    { key: "plugin", enabled: true, trustStatus: "untrusted", sourcePath: "/plugin/hooks.json", currentHash: "" },
  ]);
  assert.equal(f.run(), "");
  assert.deepEqual(f.writes(), []);
});

await test("missing worktree hooks allow trusted primary hooks with a warning and no trust write", (t) => {
  const f = fixture(t);
  rmSync(join(f.worktree, ".codex/hooks.json"));
  f.set([{ ...f.entry, trustStatus: "trusted" }]);
  const output = JSON.parse(f.run());
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
  assert.match(output.systemMessage, /configuration differs/);
  assert.equal(output.hookSpecificOutput.additionalContext, output.systemMessage);
  assert.deepEqual(f.writes(), []);
});

await test("approves enabled hooks at the primary source for a matching linked worktree", (t) => {
  const f = fixture(t);
  f.set([f.entry, { ...f.entry, key: "foreign", sourcePath: "/other/.codex/hooks.json" }]);
  assert.equal(f.run(), "");
  assert.deepEqual(f.writes(), [
    {
      keyPath: "hooks.state",
      mergeStrategy: "upsert",
      value: { [f.entry.key]: { trusted_hash: f.entry.currentHash } },
    },
  ]);
});

await test("disabled repository hooks stay disabled and visibly block delegate start", (t) => {
  const f = fixture(t);
  f.set([{ ...f.entry, enabled: false }]);
  assert.match(f.run(), /Codex would still skip/);
  assert.deepEqual(f.writes(), []);
});

await test("a trust write that does not establish trust blocks delegate start", (t) => {
  const f = fixture(t);
  f.set([f.entry], { ignoreWrites: true });
  assert.match(f.run(), /Codex would still skip/);
  assert.equal(f.writes().length, 1);
});

await test("empty or incomplete hook discovery cannot silently pass", (t) => {
  const f = fixture(t);
  f.set([]);
  assert.match(f.run(), /did not load all project hooks/);
  assert.deepEqual(f.writes(), []);
});

await test("malformed discovery fails closed without a trust write", (t) => {
  const f = fixture(t);
  f.set([f.entry], { response: { data: [{}] } });
  assert.match(f.run(), /permissionDecision.*deny/);
  assert.deepEqual(f.writes(), []);
});

await test("primary-checkout sessions use the same approval policy", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [resolve(".agents/hooks/codex-trust.ts")], {
    cwd: f.worktree,
    input: JSON.stringify({ cwd: f.main, tool_input: { target: { providerInstanceId: "codex" } } }),
    env: {
      ...process.env,
      PATH: `${join(dirname(f.main), "bin")}:${process.env.PATH}`,
      FAKE_CODEX_STATE: join(dirname(f.main), "rpc.json"),
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(f.writes().length, 1);
});

await test("loads and trusts each rotation event using the shared primary-checkout keys", (t) => {
  const f = fixture(t);
  const config = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "node rotation.ts codex" }] }],
      Stop: [{ hooks: [{ type: "command", command: "node rotation.ts codex" }] }],
      PreCompact: [{ matcher: "auto", hooks: [{ type: "command", command: "node rotation.ts codex" }] }],
    },
  };
  for (const repo of [f.main, f.worktree]) writeFileSync(join(repo, ".codex/hooks.json"), JSON.stringify(config));
  f.mergeConfig();
  const keys = ["user_prompt_submit", "stop", "pre_compact"].map((event) => `${f.source}:${event}:0:0`);
  f.set(keys.map((key) => ({ ...f.entry, key, currentHash: `sha256:${key}` })));
  assert.equal(f.run(), "");
  assert.deepEqual(
    f.writes()[0].value,
    Object.fromEntries(keys.map((key) => [key, { trusted_hash: `sha256:${key}` }])),
  );
});

await test("unmerged primary content matching the worktree receives no approval", (t) => {
  const f = fixture(t);
  const unmerged = `${readFileSync(f.source, "utf8")}\n`;
  for (const repo of [f.main, f.worktree]) writeFileSync(join(repo, ".codex/hooks.json"), unmerged);
  assert.match(f.run(), /Codex would still skip/);
  assert.deepEqual(f.writes(), []);
});

await test("primary behind merged main allows trusted hooks with a warning even when worktree matches primary", (t) => {
  const f = fixture(t);
  const original = readFileSync(f.source);
  writeFileSync(f.source, `${original.toString()}\n`);
  f.mergeConfig();
  writeFileSync(f.source, original);
  f.set([{ ...f.entry, trustStatus: "trusted" }]);
  const output = JSON.parse(f.run());
  assert.match(output.systemMessage, /inactive/);
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
  assert.deepEqual(f.writes(), []);
});

await test("stale primary with an untrusted hook denies without approval", (t) => {
  const f = fixture(t);
  writeFileSync(f.source, `${readFileSync(f.source, "utf8")}\n`);
  assert.match(f.run(), /Codex would still skip/);
  assert.deepEqual(f.writes(), []);
});

await test("hash changes during approval deny even if discovery reports trusted", (t) => {
  const f = fixture(t);
  f.set([f.entry], { changeHashOnWrite: true });
  assert.match(f.run(), /hash.*changed/i);
  assert.equal(f.writes().length, 1);
});

await test("a declared primary key absent from nonempty discovery denies", (t) => {
  const f = fixture(t);
  f.set([{ ...f.entry, key: `${f.source}:stop:0:0`, trustStatus: "trusted" }]);
  assert.match(f.run(), /did not load all project hooks/);
  assert.deepEqual(f.writes(), []);
});

await test("primary bytes changed during discovery cannot receive approval", (t) => {
  const f = fixture(t);
  f.set([f.entry], { editSource: f.source });
  assert.match(f.run(), /changed/);
  assert.deepEqual(f.writes(), []);
});
