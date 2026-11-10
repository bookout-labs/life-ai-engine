import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { Rule } from "../rules.ts";
import { render, validate } from "./rules.ts";

const hook: Rule = {
  id: "guard",
  rule: "Protect instructions",
  trigger: "write",
  route: {
    kind: "hook",
    file: ".agents/hooks/guard.ts",
    event: "PreToolUse",
    tools: { claude: ["Bash"], codex: ["Bash"] },
  },
};
function fixture(t: { after: (fn: () => void) => void }, rules = [hook], map = "A map."): string {
  const repo = mkdtempSync(join(resolve(import.meta.dirname, "../../node_modules"), "life-rules-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  for (const dir of [".agents/hooks", ".agents/scripts", ".claude", ".codex", ".github/workflows"])
    mkdirSync(join(repo, dir), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { check: "node .agents/scripts/rules.ts" } }));
  writeFileSync(join(repo, "AGENTS.md"), render(map, rules));
  writeFileSync(join(repo, "CLAUDE.md"), "@AGENTS.md\n");
  for (const config of [".claude/settings.json", ".codex/hooks.json"])
    writeFileSync(
      join(repo, config),
      JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "node .agents/hooks/guard.ts" }] }] },
      }),
    );
  writeFileSync(join(repo, hook.route.file), "");
  writeFileSync(join(repo, ".agents/hooks/guard.test.ts"), 'import "./guard.ts";');
  return repo;
}
await test("accepts a wired, tested hook and an exact render", (t) => {
  assert.deepEqual(validate(fixture(t), "A map.", [hook]), []);
});
await test("rejects missing, unwired and untested hooks", (t) => {
  const repo = fixture(t);
  rmSync(join(repo, hook.route.file));
  assert.match(validate(repo, "A map.", [hook]).join("\n"), /missing route/);
  writeFileSync(join(repo, hook.route.file), "");
  rmSync(join(repo, ".agents/hooks/guard.test.ts"));
  assert.match(validate(repo, "A map.", [hook]).join("\n"), /untested route/);
  for (const config of [".claude/settings.json", ".codex/hooks.json"]) {
    writeFileSync(
      join(repo, config),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node .agents/hooks/guard.ts" }] }] } }),
    );
    assert.ok(validate(repo, "A map.", [hook]).some((error) => error.includes(`not wired in ${config}`)));
  }
});
await test("rejects AGENTS drift, MAP overflow and duplicate ids", (t) => {
  const repo = fixture(t);
  writeFileSync(join(repo, "AGENTS.md"), "handwritten rule");
  assert.match(validate(repo, "A map.", [hook]).join("\n"), /drift/);
  assert.match(validate(repo, "word ".repeat(251), [hook]).join("\n"), /250 words/);
  assert.match(validate(repo, "A map.", [hook, hook]).join("\n"), /Duplicate/);
});
await test("requires checks to run from check or workflows and to have tests", (t) => {
  const rule: Rule = {
    id: "check",
    rule: "Verify",
    trigger: "CI",
    route: { kind: "check", file: ".agents/scripts/gate.ts" },
  };
  const repo = fixture(t, [rule]);
  writeFileSync(join(repo, ".agents/scripts/gate.ts"), "");
  assert.match(validate(repo, "A map.", [rule]).join("\n"), /not invoked/);
  writeFileSync(
    join(repo, ".github/workflows/check.yml"),
    "jobs:\n  check:\n    steps:\n      - run: node .agents/scripts/gate.ts\n",
  );
  assert.match(validate(repo, "A map.", [rule]).join("\n"), /untested route/);
  writeFileSync(join(repo, ".agents/scripts/gate.test.ts"), 'import "./gate.ts";');
  assert.deepEqual(validate(repo, "A map.", [rule]), []);
});

await test("a hook whose matcher never fires on its tools is unwired", (t) => {
  const tools = { claude: ["Write"], codex: ["apply_patch"] };
  const rule: Rule = { ...hook, route: { ...hook.route, tools } } as Rule;
  const repo = fixture(t, [rule]);
  assert.deepEqual(validate(repo, "A map.", [rule]), []);
  writeFileSync(
    join(repo, ".claude/settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "node .agents/hooks/guard.ts" }] }],
      },
    }),
  );
  assert.match(validate(repo, "A map.", [rule]).join("\n"), /matcher never fires on Write/);
});

await test("mentions in comments, echo commands and unrelated npm scripts are not check invocations", (t) => {
  const rule: Rule = {
    id: "check",
    rule: "Verify",
    trigger: "CI",
    route: { kind: "check", file: ".agents/scripts/gate.ts" },
  };
  const repo = fixture(t, [rule]);
  writeFileSync(join(repo, ".agents/scripts/gate.ts"), "");
  writeFileSync(join(repo, ".agents/scripts/gate.test.ts"), 'import "./gate.ts";');
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ scripts: { check: "echo node .agents/scripts/gate.ts", other: "node .agents/scripts/gate.ts" } }),
  );
  writeFileSync(
    join(repo, ".github/workflows/check.yml"),
    "# node .agents/scripts/gate.ts\njobs:\n  check:\n    steps:\n      - run: echo .agents/scripts/gate.ts\n",
  );
  assert.match(validate(repo, "A map.", [rule]).join("\n"), /not invoked/);
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ scripts: { check: "npm run other", other: "node .agents/scripts/gate.ts" } }),
  );
  assert.deepEqual(validate(repo, "A map.", [rule]), []);
});

await test("a tool-event hook must list the tools it fires on", (t) => {
  const bare = { ...hook, route: { ...hook.route, tools: { claude: [], codex: [] } } } as Rule;
  assert.match(validate(fixture(t, [bare]), "A map.", [bare]).join("\n"), /PreToolUse route must list tools/);
  const native = { ...hook, route: { ...hook.route, tools: { claude: [], codex: ["Bash"] } } } as Rule;
  const errors = validate(fixture(t, [native]), "A map.", [native]).join("\n");
  assert.doesNotMatch(errors, /settings\.json/, "an agent with no tools listed is not checked");
});

await test("a hook command elsewhere on disk doesn't wire the repo's route", (t) => {
  const repo = fixture(t);
  for (const config of [".claude/settings.json", ".codex/hooks.json"])
    writeFileSync(
      join(repo, config),
      JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "node /tmp/.agents/hooks/guard.ts" }] }] },
      }),
    );
  assert.match(validate(repo, "A map.", [hook]).join("\n"), /not wired/);
});
