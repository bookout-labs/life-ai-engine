import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { writeHandoff } from "./handoff.ts";

test("bootstrap capture is lossless at and above the byte boundary", (t) => {
  const home = mkdtempSync(join(tmpdir(), "handoff-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const run = (data: Buffer) =>
    spawnSync(process.execPath, [resolve(".agents/scripts/handoff.ts"), "capture"], {
      input: data,
      env: { ...process.env, HOME: home },
    });
  for (const data of [Buffer.alloc(0), Buffer.alloc(40000, "x")]) {
    const result = run(data);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.deepEqual(result.stdout, data);
  }
  assert.deepEqual(readdirSync(join(home, ".life-ai/handoffs/bootstrap")), []);
  for (const data of [Buffer.alloc(40001, "x"), Buffer.from("🧪".repeat(12000))]) {
    const result = run(data);
    assert.equal(result.status, 0, result.stderr.toString());
    const receipt = JSON.parse(result.stdout.toString());
    assert.equal(receipt.bytes, data.length);
    assert.equal(receipt.sha256, createHash("sha256").update(data).digest("hex"));
    assert.deepEqual(readFileSync(receipt.path), data);
    assert.equal(statSync(receipt.path).mode & 0o777, 0o600);
    assert.ok(result.stdout.length < 1000);
  }
});

test("handoff validates required recovery fields and bounds the header in UTF-8 bytes", () => {
  const packet = {
    header: {
      status: "synthetic",
      retiringThreadId: "synthetic-thread",
      blockers: [],
      nextAction: "Inspect existing job",
      detailPaths: ["private-state"],
      jobReportPaths: ["private-report"],
    },
    standingOrders: "Preserve active jobs",
    programStore: "private-store",
    state: "synthetic state",
    jobs: [
      {
        taskId: "synthetic-task",
        reportingTo: "synthetic-destination",
        reportPath: "private-report",
        status: "running",
      },
    ],
  };
  const run = (value: unknown) =>
    spawnSync(process.execPath, [resolve(".agents/scripts/handoff.ts"), "validate"], {
      input: JSON.stringify(value),
      encoding: "utf8",
    });
  const result = run(packet);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^HANDOFF-HEADER v1\n/);
  assert.ok(Buffer.byteLength(result.stdout) <= 2000);
  assert.doesNotMatch(result.stdout, /synthetic-task|synthetic state|Preserve active jobs/);
  const baseBytes = Buffer.byteLength(result.stdout);
  const atLimit = {
    ...packet,
    header: { ...packet.header, status: "s".repeat(2000 - baseBytes + packet.header.status.length) },
  };
  assert.equal(Buffer.byteLength(run(atLimit).stdout), 2000);
  assert.equal(run(atLimit).status, 0);
  assert.equal(run({ ...atLimit, header: { ...atLimit.header, status: `${atLimit.header.status}x` } }).status, 1);
  assert.equal(run({ ...packet, header: { ...packet.header, status: "🧪".repeat(500) } }).status, 1);
  assert.equal(run({ ...packet, jobs: [{}] }).status, 1);
  assert.equal(run({ ...packet, jobs: [packet.jobs[0], packet.jobs[0]] }).status, 1);
  assert.equal(run({ ...packet, standingOrders: "" }).status, 1);
  assert.equal(run({ ...packet, extra: true }).status, 1);
  assert.equal(run({ ...packet, header: { ...packet.header, extra: true } }).status, 1);
  assert.equal(run({ ...packet, jobs: [{ ...packet.jobs[0], extra: true }] }).status, 1);
});

test("capture and storage errors return failure without leaking input", (t) => {
  const home = mkdtempSync(join(tmpdir(), "handoff-error-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, "blocked"), "file");
  const result = spawnSync(process.execPath, [resolve(".agents/scripts/handoff.ts"), "capture"], {
    input: "synthetic-private",
    env: { ...process.env, HOME: join(home, "blocked") },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private/);
  const invalid = spawnSync(process.execPath, [resolve(".agents/scripts/handoff.ts"), "write", "bad-slug"], {
    input: "synthetic-private",
    encoding: "utf8",
  });
  assert.equal(invalid.status, 1);
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /synthetic-private/);
});

test("handoff creation rejects reused slugs and concurrent first writes atomically", {
  skip: !process.env.HANDOFF_TEST_DATABASE_URL,
}, async () => {
  const { default: pg } = await import("pg");
  const connectionString = process.env.HANDOFF_TEST_DATABASE_URL;
  const source = new pg.Pool({ connectionString });
  const schema = `handoff_test_${process.pid}`;
  const db = new pg.Pool({ connectionString, options: `-c search_path=${schema},public` });
  const packet = {
    header: {
      status: "synthetic",
      retiringThreadId: "synthetic-thread",
      blockers: [],
      nextAction: "Continue existing work",
      detailPaths: ["private-state"],
      jobReportPaths: [],
    },
    standingOrders: "Preserve existing work",
    programStore: "private-store",
    state: "original packet",
    jobs: [],
  };
  try {
    await source.query(`create schema ${schema}`);
    const sql = readFileSync(new URL("../../db/migrations/20261109120000_pages_files.sql", import.meta.url), "utf8");
    await db.query(sql.split("-- migrate:down")[0] ?? "");
    const first = await writeHandoff(db, "handoff/first", packet);
    await assert.rejects(writeHandoff(db, "handoff/first", { ...packet, state: "replacement" }), /Page changed/);
    const original = await db.query("select body from pages where slug=$1", ["handoff/first"]);
    assert.ok(original.rows[0].body.includes("original packet"));
    assert.ok(!original.rows[0].body.includes("replacement"));
    assert.equal(Buffer.byteLength(original.rows[0].body), first.bytes);
    const race = await Promise.allSettled([
      writeHandoff(db, "handoff/race", packet),
      writeHandoff(db, "handoff/race", { ...packet, state: "other candidate" }),
    ]);
    assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await db.query("select count(*)::int as n from pages")).rows[0].n, 2);
    assert.equal((await db.query("select count(*)::int as n from page_revisions")).rows[0].n, 2);
  } finally {
    await db.end();
    await source.query(`drop schema if exists ${schema} cascade`);
    await source.end();
  }
});
