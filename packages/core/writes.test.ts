import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { investmentBuys } from "./investment-buys.ts";
import { logWorkout, logWorkoutSchema } from "./log-workout.ts";
import { recordInvestmentBuy, recordInvestmentBuySchema } from "./record-investment-buy.ts";
import { recentWorkouts } from "./workouts.ts";

test("write tools reject invalid payloads before accessing the database", () => {
  const buy = {
    request_id: randomUUID(),
    state: "completed",
    symbol: "ABC",
    account_ref: "fixture",
    executed_on: "2040-01-01",
    amount: "99.50",
  };
  assert.equal(recordInvestmentBuySchema.safeParse(buy).success, true);
  for (const patch of [
    { request_id: "bad" },
    { amount: 99.5 },
    { amount: "NaN" },
    { amount: "1.001" },
    { amount: "0" },
    { executed_on: null },
    { symbol: " " },
    { executed_on: "2040-02-30" },
    { state: "planned" },
  ]) {
    assert.equal(recordInvestmentBuySchema.safeParse({ ...buy, ...patch }).success, false);
  }
  const session = {
    request_id: randomUUID(),
    performed_on: "2040-01-01",
    kind: "strength",
    blocks: [{ position: 1, name: "press", weight: "0", weight_unit: "kg" }],
  };
  assert.equal(logWorkoutSchema.safeParse(session).success, true);
  for (const blocks of [
    [{ position: 0, name: "press" }],
    [{ position: 1, name: " " }],
    [{ position: 1, name: "press", reps: 0 }],
    [{ position: 1, name: "press", weight: "5" }],
    [{ position: 1, name: "press", weight: "Infinity", weight_unit: "kg" }],
    [
      { position: 1, name: "press" },
      { position: 1, name: "warmup" },
    ],
  ])
    assert.equal(logWorkoutSchema.safeParse({ ...session, blocks }).success, false);
});

test("buy and workout writes read back, converge on retries, and roll back invalid sessions", {
  skip: !process.env.WRITES_TEST_DATABASE_URL,
}, async () => {
  const db = new pg.Pool({ connectionString: process.env.WRITES_TEST_DATABASE_URL });
  try {
    for (const name of [
      "20261110120000_investment_buys",
      "20261110000000_workouts",
      "20261110160000_write_request_ids",
    ]) {
      const sql = await readFile(new URL(`../../db/migrations/${name}.sql`, import.meta.url), "utf8");
      const [up] = sql.split("-- migrate:down");
      assert.ok(up);
      await db.query(up);
    }
    const input = {
      request_id: randomUUID(),
      state: "completed",
      symbol: "ABC",
      account_ref: "fixture account",
      executed_on: "2040-01-02",
      amount: "99.50",
    } as const;
    const first = await recordInvestmentBuy(db, input);
    assert.equal(first.already_existed, false);
    assert.deepEqual(await recordInvestmentBuy(db, { ...input, amount: "200.00" }), {
      ...first,
      already_existed: true,
    });
    assert.equal((await investmentBuys(db)).completed[0]?.amount, "99.50");
    const retry = { ...input, request_id: randomUUID() };
    const pair = await Promise.all([recordInvestmentBuy(db, retry), recordInvestmentBuy(db, retry)]);
    assert.equal(pair[0].id, pair[1].id);
    assert.deepEqual(pair.map((r) => r.already_existed).sort(), [false, true]);
    assert.equal((await investmentBuys(db)).completed.length, 2);
    await recordInvestmentBuy(db, {
      request_id: randomUUID(),
      state: "planned",
      symbol: "XYZ",
      account_ref: "fixture",
      planned_condition: "when ready",
    });
    assert.equal((await investmentBuys(db)).planned.length, 1);
    await assert.rejects(recordInvestmentBuy(db, { ...input, request_id: randomUUID(), amount: "0" }), {
      code: "23514",
    });
    for (const patch of [
      { symbol: " " },
      { executed_on: null },
      { amount: null },
      { state: "planned" as const, executed_on: null },
    ]) {
      await assert.rejects(recordInvestmentBuy(db, { ...input, ...patch, request_id: randomUUID() }), {
        code: "23514",
      });
    }
    const session = {
      request_id: randomUUID(),
      performed_on: "2040-01-03",
      kind: "strength",
      notes: "fixture",
      blocks: [
        { position: 2, name: "press", sets: 3, reps: 8, weight: "42.5", weight_unit: "kg" },
        { position: 1, name: "warmup", duration_seconds: 300 },
      ],
    } as const;
    const workout = await logWorkout(db, { ...session, blocks: [...session.blocks] });
    assert.equal(workout.already_existed, false);
    assert.equal(workout.block_ids.length, 2);
    assert.deepEqual(await logWorkout(db, { ...session, blocks: [] }), { ...workout, already_existed: true });
    const sessions = await recentWorkouts(db, 10);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.id, workout.id);
    assert.deepEqual(
      sessions[0]?.blocks.map((b) => b.name),
      ["warmup", "press"],
    );
    assert.equal(sessions[0]?.blocks[1]?.weight, "42.5");
    const concurrent = { ...session, request_id: randomUUID(), blocks: [...session.blocks] };
    const workouts = await Promise.all([logWorkout(db, concurrent), logWorkout(db, concurrent)]);
    assert.equal(workouts[0].id, workouts[1].id);
    assert.deepEqual(workouts[0].block_ids, workouts[1].block_ids);
    assert.deepEqual(workouts.map((r) => r.already_existed).sort(), [false, true]);
    assert.equal((await recentWorkouts(db, 10)).length, 2);
    const failed = {
      ...session,
      request_id: randomUUID(),
      blocks: [session.blocks[1], { ...session.blocks[0], reps: 0 }],
    };
    await assert.rejects(logWorkout(db, failed), { code: "23514" });
    assert.equal((await recentWorkouts(db, 10)).length, 2);
    assert.equal((await logWorkout(db, { ...failed, blocks: [...session.blocks] })).already_existed, false);
    for (const blocks of [
      [{ position: 1, name: "press", weight: "5" }],
      [
        { position: 1, name: "press" },
        { position: 1, name: "warmup" },
      ],
    ])
      await assert.rejects(logWorkout(db, { ...session, request_id: randomUUID(), blocks }));
    assert.equal((await recentWorkouts(db, 10)).length, 3);
  } finally {
    await db.query("drop table if exists workout_blocks, workouts, investment_buys");
    await db.end();
  }
});
