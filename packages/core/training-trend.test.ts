import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { summarizeTraining, trainingTrend, trainingTrendSchema } from "./training-trend.ts";
import type { Workout } from "./workouts.ts";

test("empty history retains zero weeks and marks the current week partial", () => {
  const result = summarizeTraining([], { asOf: "2040-01-18", weeks: 2 });
  assert.deepEqual(
    result.weeks.map((w) => [w.week, w.partial, w.sessions]),
    [
      ["2040-01-09", false, 0],
      ["2040-01-16", true, 0],
    ],
  );
  assert.deepEqual(result.flags, []);
});

function session(day: string, patch: Partial<Workout["blocks"][number]> = {}, kind = "strength"): Workout {
  return {
    id: day,
    performed_on: day,
    kind,
    notes: null,
    blocks: [
      {
        position: 1,
        name: "fixture",
        sets: 2,
        reps: 5,
        weight: "10",
        weight_unit: "kg",
        duration_seconds: 600,
        notes: null,
        ...patch,
      },
    ],
  };
}
const baseline = ["2040-01-02", "2040-01-09", "2040-01-16"].map((day) => session(day));
const options = { asOf: "2040-01-30", weeks: 5 };

test("ISO weeks use stored local dates across the year boundary without timezone shifts", () => {
  const result = summarizeTraining(
    [session("2039-12-31"), session("2040-01-01"), session("2040-01-02"), session("2040-01-03")],
    { asOf: "2040-01-02", weeks: 2 },
  );
  assert.deepEqual(
    result.weeks.map((w) => [w.week, w.sessions]),
    [
      ["2039-12-26", 2],
      ["2040-01-02", 1],
    ],
  );
  assert.deepEqual(result.flags, []);
});

test("totals combine known blocks and mixed weight units, preserve unknowns, and group by kind", () => {
  const result = summarizeTraining(
    [
      session("2040-01-02"),
      session("2040-01-03", { weight: "10", weight_unit: "lb", duration_seconds: null }),
      session("2040-01-04", { weight: null, weight_unit: null, sets: null, duration_seconds: null }, "mobility"),
      { ...session("2040-01-05"), blocks: [], kind: "__proto__" },
      session("2039-12-01"),
    ],
    { asOf: "2040-01-05", weeks: 1 },
  );
  const row = result.weeks[0];
  assert.ok(row);
  assert.equal(row.sessions, 4);
  assert.equal(row.duration_seconds, 600);
  assert.equal(row.volume_kg, 145.36);
  assert.equal(row.timed_blocks, 1);
  assert.equal(row.loaded_blocks, 2);
  assert.equal(row.blocks, 3);
  assert.equal(row.by_kind.strength?.sessions, 2);
  assert.equal(row.by_kind.mobility?.volume_kg, null);
  assert.equal(row.by_kind.mobility?.duration_seconds, null);
  assert.equal(Object.entries(row.by_kind).find(([kind]) => kind === "__proto__")?.[1].sessions, 1);
});

test("completed weeks flag volume and duration spikes with baseline evidence", () => {
  const result = summarizeTraining(
    [...baseline, session("2040-01-23", { weight: "20", duration_seconds: 1000 })],
    options,
  );
  assert.deepEqual(
    result.flags.map((f) => f.kind),
    ["load_spike", "load_spike"],
  );
  const flag = result.flags[0];
  assert.ok(flag?.kind === "load_spike");
  assert.equal(flag.metric, "duration_seconds");
  assert.equal(flag.baseline, 600);
  assert.equal(flag.value, 1000);
  assert.deepEqual(flag.evidence_weeks, ["2040-01-02", "2040-01-09", "2040-01-16", "2040-01-23"]);
  assert.ok(flag.reason.length > 0);
});

test("spike requires more than 150 percent and three measured complete baseline weeks", () => {
  for (const sessions of [
    [...baseline, session("2040-01-23", { weight: "15", duration_seconds: 900 })],
    [baseline[0], baseline[2], session("2040-01-23", { weight: "20", duration_seconds: 1200 })].filter(
      (s): s is Workout => s !== undefined,
    ),
    [...baseline.map((s) => ({ ...s, blocks: [] })), session("2040-01-23")],
  ]) {
    assert.deepEqual(summarizeTraining(sessions, options).flags, []);
  }
});

test("partial current weeks never trigger load spikes or sharp drops", () => {
  const active = baseline.flatMap((s) => [s, { ...s, id: `${s.id}-second` }]);
  for (const sessions of [active, [...active, session("2040-01-23", { weight: "100", duration_seconds: 10000 })]]) {
    const result = summarizeTraining(sessions, { asOf: "2040-01-29", weeks: 4 });
    assert.equal(result.weeks.at(-1)?.partial, true);
    assert.deepEqual(result.flags, []);
  }
});

test("seven unique consecutive logged days flag no rest across weeks, including a partial week", () => {
  const sessions = ["20", "21", "22", "23", "24", "25", "26"].map((day) => session(`2040-01-${day}`));
  const result = summarizeTraining(
    [...sessions, sessions[0]].filter((s): s is Workout => !!s),
    { asOf: "2040-01-26", weeks: 2 },
  );
  assert.deepEqual(
    result.flags.map((f) => f.kind),
    ["no_rest"],
  );
  const flag = result.flags[0];
  assert.ok(flag?.kind === "no_rest");
  assert.equal(flag.consecutive_days, 7);
  assert.equal(flag.from, "2040-01-20");
  assert.equal(flag.through, "2040-01-26");
  assert.deepEqual(flag.evidence_weeks, ["2040-01-16", "2040-01-23"]);
  for (const subset of [sessions.slice(1), sessions.filter((s) => s.performed_on !== "2040-01-23")]) {
    assert.deepEqual(summarizeTraining([...subset, ...subset], { asOf: "2040-01-26", weeks: 2 }).flags, []);
  }
});

test("a completed week with half the sessions or a gap flags a drop after a steady streak", () => {
  const steady = baseline.flatMap((s) => [s, { ...s, id: `${s.id}-second` }]);
  for (const tail of [[], [session("2040-01-23")]]) {
    const flags = summarizeTraining([...steady, ...tail], options).flags;
    assert.deepEqual(
      flags.map((f) => f.kind),
      ["sharp_drop"],
    );
    const flag = flags[0];
    assert.ok(flag?.kind === "sharp_drop");
    assert.equal(flag.sessions, tail.length);
    assert.equal(flag.baseline, 2);
    assert.deepEqual(flag.evidence_weeks, ["2040-01-02", "2040-01-09", "2040-01-16", "2040-01-23"]);
  }
  assert.deepEqual(summarizeTraining(baseline, options).flags, []);
  assert.deepEqual(summarizeTraining([...steady, session("2040-01-23"), session("2040-01-24")], options).flags, []);
});

test("input boundary rejects invalid dates and unbounded ranges", () => {
  for (const input of [{ asOf: "2040-02-30" }, { weeks: 0 }, { weeks: 53 }, { weeks: 1.5 }]) {
    assert.equal(trainingTrendSchema.safeParse(input).success, false);
  }
});

test("wrapper reads inclusive dates and blocks from PostgreSQL without writing", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  const migration = await readFile(new URL("../../db/migrations/20261110000000_workouts.sql", import.meta.url), "utf8");
  const [up, down] = migration.split("-- migrate:down");
  assert.ok(up && down);
  let migrated = false;
  try {
    await db.query(up.replaceAll("create table ", "create temp table "));
    migrated = true;
    await db.query(`insert into workouts (performed_on, kind) values
      ('2040-01-01', 'strength'), ('2040-01-02', 'strength'), ('2040-01-08', 'conditioning'), ('2040-01-09', 'strength');
      insert into workout_blocks (workout_id, position, name, sets, reps, weight, weight_unit, duration_seconds)
      values (2, 1, 'fixture', 2, 5, 10, 'kg', 600);`);
    await db.query("begin read only");
    const result = await trainingTrend(db, { asOf: "2040-01-08", weeks: 1 });
    assert.equal(result.weeks[0]?.week, "2040-01-02");
    assert.equal(result.weeks[0]?.sessions, 2);
    assert.equal(result.weeks[0]?.duration_seconds, 600);
    assert.equal(result.weeks[0]?.volume_kg, 100);
    assert.equal(result.weeks[0]?.by_kind.conditioning?.sessions, 1);
    assert.deepEqual(result.flags, []);
    assert.equal((await trainingTrend(db, { asOf: "2040-01-08" })).weeks.length, 8);
    await db.query("rollback");
    await db.query("delete from workouts");
    await db.query(`insert into workouts (performed_on, kind)
      select d::date, 'strength' from generate_series('2040-01-17'::date, '2040-01-25'::date, '1 day') d`);
    const crossing = await trainingTrend(db, { asOf: "2040-01-30", weeks: 2 });
    assert.equal(crossing.flags.find((f) => f.kind === "no_rest")?.consecutive_days, 9);
    assert.equal(
      crossing.weeks.reduce((sum, w) => sum + w.sessions, 0),
      3,
    );
  } finally {
    await db.query("rollback");
    if (migrated) await db.query(down);
    await db.end();
  }
});

test("a run crossing the window start is counted", () => {
  const sessions = Array.from({ length: 9 }, (_, i) => session(`2040-01-${String(17 + i).padStart(2, "0")}`));
  const result = summarizeTraining(sessions, { asOf: "2040-01-30", weeks: 2 });
  const flag = result.flags.find((f) => f.kind === "no_rest");
  assert.ok(flag && flag.kind === "no_rest");
  assert.equal(flag.consecutive_days, 9);
});

test("reported pound volumes are rounded", () => {
  const result = summarizeTraining(
    [session("2040-01-23", { weight: "135", weight_unit: "lb", sets: 3, reps: 10 })],
    options,
  );
  assert.equal(result.weeks[3]?.volume_kg, 1837.05);
  assert.equal(result.weeks[3]?.by_kind.strength?.volume_kg, 1837.05);
});

test("a missing rep count does not contribute loaded volume", () => {
  const row = summarizeTraining([session("2040-01-23", { reps: null })], options).weeks[3];
  assert.equal(row?.volume_kg, null);
  assert.equal(row?.loaded_blocks, 0);
});

test("a drop from three sessions flags one but not two", () => {
  const steady = baseline.flatMap((s) => [s, { ...s, id: s.id + "b" }, { ...s, id: s.id + "c" }]);
  for (const count of [1, 2]) {
    const tail = Array.from({ length: count }, (_, i) => ({ ...session("2040-01-23"), id: String(i) }));
    assert.equal(
      summarizeTraining([...steady, ...tail], options).flags.some((f) => f.kind === "sharp_drop"),
      count === 1,
    );
  }
});
