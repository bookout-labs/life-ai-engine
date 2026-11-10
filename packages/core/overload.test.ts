import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { overloadWeeks } from "./overload.ts";
import { temporarySchema } from "./test-schema.ts";
import { weekly } from "./weekly.ts";

test("booked evenings count once per local date across weeks and daylight saving", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  try {
    await db.query(await temporarySchema());
    const member = await db.query("insert into members (first_name) values ('Sample') returning id");
    const activity = await db.query(
      "insert into activities (member_id, activity, season_start) values ($1, 'sample', '2040-01-01') returning id",
      [member.rows[0].id],
    );
    const id = activity.rows[0].id;
    for (const [start, end, cancelled] of [
      ["2040-03-08 16:00", "2040-03-08 17:00", false],
      ["2040-03-05 20:59", "2040-03-05 22:00", false],
      ["2040-03-05 18:00", "2040-03-05 19:00", false],
      ["2040-03-06 16:30", null, false],
      ["2040-03-08 18:00", "2040-03-08 19:00", true],
      ["2040-03-11 18:00", "2040-03-11 19:00", false],
      ["2040-03-12 18:00", "2040-03-12 19:00", false],
      ["2040-03-13 18:00", "2040-03-13 19:00", false],
      ["2040-03-14 18:00", "2040-03-14 19:00", false],
      ["2040-03-15 18:00", "2040-03-15 19:00", false],
      ["2040-03-20 22:00", "2040-03-21 18:00", false],
    ] as const) {
      await db.query(
        "insert into events (activity_id, kind, starts_at, ends_at, cancelled) values ($1, 'sample', $2::timestamp at time zone 'America/Chicago', $3::timestamp at time zone 'America/Chicago', $4)",
        [id, start, end, cancelled],
      );
    }
    assert.deepEqual(await overloadWeeks(db, "2040-03-11"), [
      {
        weekStart: "2040-03-05",
        bookedEveningCount: 3,
        bookedDates: ["2040-03-05", "2040-03-06", "2040-03-11"],
        overloaded: false,
      },
      {
        weekStart: "2040-03-12",
        bookedEveningCount: 4,
        bookedDates: ["2040-03-12", "2040-03-13", "2040-03-14", "2040-03-15"],
        overloaded: true,
      },
      { weekStart: "2040-03-19", bookedEveningCount: 1, bookedDates: ["2040-03-21"], overloaded: false },
    ]);
    assert.deepEqual((await weekly(db, "2040-03-11")).overloadWeeks, await overloadWeeks(db, "2040-03-11"));
    assert.equal((await overloadWeeks(db, "2040-03-12"))[0]?.weekStart, "2040-03-12");
  } finally {
    await db.end();
  }
});
