import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { z } from "zod";

const workflow = z
  .object({
    jobs: z.object({
      secrets: z.object({ steps: z.array(z.object({ name: z.string().optional(), run: z.string().optional() })) }),
    }),
  })
  .parse(parse(readFileSync(".github/workflows/gate.yml", "utf8")));
const scan = workflow.jobs.secrets.steps.find((step) => step.name === "Scan added lines without exposing values")?.run;
const binary = process.env.GITLEAKS_TEST_BINARY;

test("pinned gitleaks scans additions with private exact exceptions and safe diagnostics", { skip: !binary }, () => {
  assert.ok(scan, "workflow scan step exists");
  assert.ok(binary);
  assert.equal(spawnSync(binary, ["version"], { encoding: "utf8" }).stdout.trim(), "8.30.1");
  const dir = mkdtempSync(join(tmpdir(), "life-ai-secrets-"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-C", dir, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, "fixture git command succeeded");
    return result.stdout.trim();
  };
  const commit = (text: string) => {
    writeFileSync(join(dir, "fixture.txt"), text);
    git("add", "fixture.txt");
    git("commit", "-qm", "synthetic fixture");
    return git("rev-parse", "HEAD");
  };
  const run = (base: string, head: string, allowlist = "[]") =>
    spawnSync("bash", ["-e", "-c", scan], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, BASE: base, HEAD: head, PERSONAL_DATA_ALLOWLIST: allowlist },
    });
  try {
    git("init", "-q");
    git("config", "user.name", "Synthetic fixture");
    git("config", "user.email", ["fixture", "example.invalid"].join("@"));
    mkdirSync(join(dir, ".github"));
    copyFileSync(".github/personal-data.toml", join(dir, ".github/personal-data.toml"));
    symlinkSync(resolve(binary), join(dir, "gitleaks"));
    const base = commit("ordinary\n");
    const value = ["000", "12", "3456"].join("-");
    const head = commit(`ordinary\n${value}\n`);
    const refused = run(base, head);
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /fixture.txt.*:2/);
    assert.ok(!(refused.stdout + refused.stderr).includes(value));
    assert.equal(run(base, head, JSON.stringify([value])).status, 0);
    assert.equal(run(base, head, JSON.stringify([`${value}x`])).status, 1);
    const contextOnly = commit(`updated\n${value}\n`);
    assert.equal(run(head, contextOnly).status, 0, "unchanged context is not scanned");
    const removed = commit("ordinary\n");
    assert.equal(run(contextOnly, removed).status, 0);
    assert.equal(run(base, removed).status, 1, "addition remains refused after later removal");
    const normal = commit("changed\n");
    assert.equal(run(removed, normal).status, 0);
    for (const text of [
      ["000", "12", "3456"].join(" "),
      ["000", "12", "3456"].join(""),
      ["fixture", "example.invalid"].join("@"),
      ["+1 (202)", "555-0147"].join(" "),
      ["202", "555", "0147"].join("."),
      ["202", "555", "0147"].join(""),
    ]) {
      const before = git("rev-parse", "HEAD");
      const after = commit(`changed\n${text}\n`);
      const result = run(before, after);
      assert.equal(result.status, 1, "personal-data shape refused");
      assert.ok(!(result.stdout + result.stderr).includes(text));
      assert.equal(run(before, after, JSON.stringify([text])).status, 0);
    }
    const beforeBypass = git("rev-parse", "HEAD");
    const afterBypass = commit(`${value} # gitleaks:allow\n`);
    assert.equal(run(beforeBypass, afterBypass).status, 1, "inline suppression cannot admit personal data");
    const beforeLock = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "package-lock.json"), `"${value}"\n`);
    git("add", "package-lock.json");
    git("commit", "-qm", "synthetic lockfile");
    assert.equal(
      run(beforeLock, git("rev-parse", "HEAD")).status,
      1,
      "default path exceptions do not exempt personal data",
    );
    const debug = spawnSync(
      "bash",
      ["-e", "-c", scan.replace("--redact=100", "--redact=100 --log-level=trace --verbose")],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, BASE: base, HEAD: head, PERSONAL_DATA_ALLOWLIST: "[]" },
      },
    );
    assert.equal(debug.status, 1);
    assert.ok(!(debug.stdout + debug.stderr).includes(value));
    const token = `ghp_${"Ab3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5"}`;
    const beforeToken = git("rev-parse", "HEAD");
    const afterToken = commit(`changed\n${token}\n`);
    assert.equal(run(beforeToken, afterToken, JSON.stringify([token])).status, 1, "default rules remain active");
    for (const input of ["", "invalid-private-marker", "{}", '[""]']) {
      const result = run(base, head, input);
      assert.notEqual(result.status, 0);
      assert.ok(!(result.stdout + result.stderr).includes("invalid-private-marker"));
    }
    writeFileSync(join(dir, ".github/personal-data.toml"), '[[rules]]\nid = "invalid-private-marker"\nregex = "["\n');
    const configError = run(base, head);
    assert.notEqual(configError.status, 0);
    assert.ok(!(configError.stdout + configError.stderr).includes("invalid-private-marker"));
    const invalid = run("invalid-private-marker", head);
    assert.notEqual(invalid.status, 0);
    assert.ok(!(invalid.stdout + invalid.stderr).includes("invalid-private-marker"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
