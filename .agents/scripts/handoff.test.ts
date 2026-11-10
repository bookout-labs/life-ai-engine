import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { renderHandoff, writeHandoff } from "./handoff.ts";

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
  const { header } = renderHandoff(packet);
  assert.match(header, /^HANDOFF-HEADER v1\n/);
  assert.doesNotMatch(header, /synthetic-task|synthetic state|Preserve active jobs/);
  const atLimit = {
    ...packet,
    header: { ...packet.header, status: "s".repeat(2000 - Buffer.byteLength(header) + packet.header.status.length) },
  };
  assert.equal(Buffer.byteLength(renderHandoff(atLimit).header), 2000);
  for (const bad of [
    { ...atLimit, header: { ...atLimit.header, status: `${atLimit.header.status}x` } },
    { ...packet, header: { ...packet.header, status: "🧪".repeat(500) } },
    { ...packet, jobs: [{}] },
    { ...packet, jobs: [packet.jobs[0], packet.jobs[0]] },
    { ...packet, standingOrders: "" },
    { ...packet, extra: true },
    { ...packet, header: { ...packet.header, extra: true } },
    { ...packet, jobs: [{ ...packet.jobs[0], extra: true }] },
  ])
    assert.throws(() => renderHandoff(bad));
});

test("errors fail without leaking input", () => {
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
