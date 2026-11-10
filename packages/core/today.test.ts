import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { readToday } from "./today.ts";
import { logUpkeepCompletion, upkeepDue } from "./upkeep.ts";
import { weekly } from "./weekly.ts";

test("daily and weekly readers expose overdue, due this week and unrecorded upkeep", {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2042-01-01T12:00:00Z") });
  const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  const namespace = `upkeep_views_${randomUUID().replaceAll("-", "")}`;
  try {
    await db.query(`create schema ${namespace}`);
    await db.query(`set search_path to ${namespace}, public`);
    const dir = new URL("../../db/migrations/", import.meta.url);
    for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
      const [up] = (await readFile(new URL(file, dir), "utf8")).split("-- migrate:down");
      assert.ok(up);
      await db.query(up);
    }
    for (const [name, last] of [
      ["Synthetic overdue", "2040-01-01"],
      ["Synthetic due", "2041-01-05"],
      ["Synthetic later", "2041-01-08"],
      ["Synthetic unknown", null],
    ]) {
      const {
        rows: [task],
      } = await db.query(
        "insert into upkeep_tasks (name, category, interval_months) values ($1, 'home', 1) returning id::text",
        [name],
      );
      assert.ok(task);
      if (last) await logUpkeepCompletion(db, { request_id: randomUUID(), task_id: task.id, completed_on: last });
    }
    const expected = await upkeepDue(db, "2041-02-01", 7);
    assert.deepEqual(
      expected.map((task) => task.name),
      ["Synthetic overdue", "Synthetic due", "Synthetic unknown"],
    );
    assert.deepEqual((await readToday(db, "2041-02-01T12:00:00Z")).upkeep, expected);
    assert.deepEqual((await weekly(db, "2041-02-01")).upkeep, expected);
  } finally {
    await db.query(`drop schema ${namespace} cascade`);
    await db.end();
  }
});
