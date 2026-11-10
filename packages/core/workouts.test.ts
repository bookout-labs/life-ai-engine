import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { recentWorkouts, workoutsInRange } from "./workouts.ts";

test("workouts preserve blocks and read newest sessions within inclusive dates", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  const migration = await readFile(new URL("../../db/migrations/20261110000000_workouts.sql", import.meta.url), "utf8");
  const [up, down] = migration.split("-- migrate:down");
  assert.ok(up && down);
  try {
    await db.query(up.replaceAll("create table ", "create temp table "));
    await db.query(`insert into workouts (performed_on, kind) values
      ('2040-01-01', 'strength'), ('2040-01-02', 'conditioning'), ('2040-01-03', 'mobility');
      insert into workout_blocks (workout_id, position, name, sets, reps, weight, weight_unit)
      values (1, 2, 'press', 3, 8, 42.5, 'kg');
      insert into workout_blocks (workout_id, position, name, duration_seconds)
      values (1, 1, 'warmup', 300);`);
    const sessions = await workoutsInRange(db, "2040-01-01", "2040-01-02");
    assert.deepEqual(
      sessions.map((s) => s.kind),
      ["conditioning", "strength"],
    );
    assert.deepEqual(sessions[0]?.blocks, []);
    assert.deepEqual(
      sessions[1]?.blocks.map((b) => b.name),
      ["warmup", "press"],
    );
    assert.equal(sessions[1]?.blocks[1]?.weight, "42.5");
    assert.deepEqual(
      (await recentWorkouts(db, 1)).map((s) => s.kind),
      ["mobility"],
    );
    await assert.rejects(
      db.query("insert into workout_blocks (workout_id, position, name, weight) values (1, 3, 'bad', 2)"),
    );
    await assert.rejects(
      db.query("insert into workout_blocks (workout_id, position, name, reps) values (1, 3, 'bad', 0)"),
    );
    await assert.rejects(db.query("insert into workouts (performed_on, kind) values ('2040-01-01', ' ' )"));
  } finally {
    await db.query(down);
    await db.end();
  }
});
