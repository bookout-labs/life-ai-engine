import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { listUpkeep, logUpkeepCompletion, upkeepDue } from "./upkeep.ts";

test("upkeep derives monthly dates and preserves unknown history", {
  skip: !process.env.UPKEEP_TEST_DATABASE_URL,
}, async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2042-01-01T12:00:00Z") });
  const db = new pg.Client({ connectionString: process.env.UPKEEP_TEST_DATABASE_URL });
  await db.connect();
  const namespace = `upkeep_test_${randomUUID().replaceAll("-", "")}`;
  try {
    await db.query(`create schema ${namespace}`);
    await db.query(`set search_path to ${namespace}`);
    const migration = await readFile(new URL("../../db/migrations/20261110190000_upkeep.sql", import.meta.url), "utf8");
    const [up, down] = migration.split("-- migrate:down");
    assert.ok(up && down);
    await db.query(up);
    const {
      rows: [task],
    } = await db.query(
      "insert into upkeep_tasks (name, category, interval_months) values ('Synthetic filter', 'home', 1) returning id::text",
    );
    assert.ok(task);
    const unknown = (await listUpkeep(db, "2041-02-01"))[0];
    assert.equal(unknown?.status, "no_record");
    assert.equal(unknown?.next_due_on, null);
    const input = { request_id: randomUUID(), task_id: task.id, completed_on: "2041-01-31" };
    await logUpkeepCompletion(db, input);
    const known = (await listUpkeep(db, "2041-02-01"))[0];
    assert.equal(known?.next_due_on, "2041-02-28");
    assert.equal(known?.status, "upcoming");
    assert.deepEqual(await upkeepDue(db, "2041-02-01", 7), []);
    const {
      rows: [annual],
    } = await db.query(
      "insert into upkeep_tasks (name, category, yearly_month, yearly_day) values ('Synthetic yearly check', 'vehicle', 6, 1) returning id::text",
    );
    assert.ok(annual);
    await logUpkeepCompletion(db, { request_id: randomUUID(), task_id: annual.id, completed_on: "2040-06-01" });
    assert.equal((await listUpkeep(db, "2041-05-31")).find((t) => t.id === annual.id)?.next_due_on, "2041-06-01");
    assert.equal((await listUpkeep(db, "2041-06-01")).find((t) => t.id === annual.id)?.status, "due");
    assert.equal((await listUpkeep(db, "2041-06-02")).find((t) => t.id === annual.id)?.status, "overdue");
    await t.test("completion moves the date and retry preserves the original", async () => {
      const nextInput = {
        request_id: randomUUID(),
        task_id: task.id,
        completed_on: "2041-03-05",
        notes: "Synthetic service",
      };
      const first = await logUpkeepCompletion(db, nextInput);
      assert.equal(first.already_existed, false);
      assert.deepEqual(await logUpkeepCompletion(db, { ...nextInput, completed_on: "2041-03-10", notes: "Changed" }), {
        completion: first.completion,
        already_existed: true,
      });
      assert.equal((await listUpkeep(db, "2041-03-10"))[0]?.next_due_on, "2041-04-05");
      await logUpkeepCompletion(db, { request_id: randomUUID(), task_id: task.id, completed_on: "2041-02-15" });
      assert.equal((await listUpkeep(db, "2041-03-10"))[0]?.last_done_on, "2041-03-05");
      assert.equal((await listUpkeep(db, "2041-02-01"))[0]?.last_done_on, "2041-01-31");
    });
    await t.test("due window includes overdue first and unknown history without calling it overdue", async () => {
      await db.query(
        "insert into upkeep_tasks (name, category, interval_months) values ('Synthetic unknown', 'vehicle', 3)",
      );
      const due = await upkeepDue(db, "2041-06-02", 7);
      assert.deepEqual(
        due.map((t) => [t.name, t.status]),
        [
          ["Synthetic filter", "overdue"],
          ["Synthetic yearly check", "overdue"],
          ["Synthetic unknown", "no_record"],
        ],
      );
      assert.equal((await upkeepDue(db, "2041-03-30", 7))[0]?.next_due_on, "2041-04-05");
      assert.equal(
        (await upkeepDue(db, "2041-03-29", 7)).some((t) => t.id === task.id),
        false,
      );
    });
    await t.test("yearly completion advances its calendar year and leap days clamp", async () => {
      await logUpkeepCompletion(db, { request_id: randomUUID(), task_id: annual.id, completed_on: "2041-05-15" });
      assert.equal((await listUpkeep(db, "2041-05-31")).find((t) => t.id === annual.id)?.next_due_on, "2042-06-01");
      const {
        rows: [leap],
      } = await db.query(
        "insert into upkeep_tasks (name, category, yearly_month, yearly_day) values ('Synthetic leap check', 'home', 2, 29) returning id::text",
      );
      assert.ok(leap);
      await logUpkeepCompletion(db, { request_id: randomUUID(), task_id: leap.id, completed_on: "2040-02-29" });
      assert.equal((await listUpkeep(db, "2041-01-01")).find((t) => t.id === leap.id)?.next_due_on, "2041-02-28");
    });
    await t.test("database rejects invalid schedules and completion references", async () => {
      for (const schedule of [
        [null, null, null],
        [0, null, null],
        [-1, null, null],
        [1, 6, 1],
        [null, 6, null],
        [null, null, 1],
        [null, 0, 1],
        [null, 13, 1],
        [null, 2, 30],
        [null, 4, 31],
        [null, 6, 0],
      ])
        await assert.rejects(
          db.query(
            "insert into upkeep_tasks (name, category, interval_months, yearly_month, yearly_day) values ('Synthetic bad', 'home', $1, $2, $3)",
            schedule,
          ),
          { code: "23514" },
        );
      await assert.rejects(
        logUpkeepCompletion(db, {
          request_id: randomUUID(),
          task_id: "9223372036854775807",
          completed_on: "2041-01-01",
        }),
        { code: "23503" },
      );
      await assert.rejects(
        db.query("insert into upkeep_completions (request_id, task_id, completed_on) values ($1, $2, 'infinity')", [
          randomUUID(),
          task.id,
        ]),
        { code: "23514" },
      );
    });
    await t.test("concurrent retries store one completion", async () => {
      const input = { request_id: randomUUID(), task_id: task.id, completed_on: "2041-04-01" };
      const write = async () => {
        const connection = new pg.Client({ connectionString: process.env.UPKEEP_TEST_DATABASE_URL });
        await connection.connect();
        try {
          await connection.query(`set search_path to ${namespace}`);
          return await logUpkeepCompletion(connection, input);
        } finally {
          await connection.end();
        }
      };
      const pair = await Promise.all([write(), write()]);
      assert.equal(pair[0]?.completion.id, pair[1]?.completion.id);
      assert.deepEqual(pair.map((r) => r.already_existed).sort(), [false, true]);
    });
    await t.test("multi-month and leap-year monthly intervals clamp", async () => {
      const {
        rows: [quarterly],
      } = await db.query(
        "insert into upkeep_tasks (name, category, interval_months) values ('Synthetic quarterly', 'vehicle', 3) returning id::text",
      );
      assert.ok(quarterly);
      await logUpkeepCompletion(db, { request_id: randomUUID(), task_id: quarterly.id, completed_on: "2040-11-30" });
      assert.equal((await listUpkeep(db, "2040-12-01")).find((t) => t.id === quarterly.id)?.next_due_on, "2041-02-28");
      await logUpkeepCompletion(db, { request_id: randomUUID(), task_id: task.id, completed_on: "2040-01-31" });
      assert.equal((await listUpkeep(db, "2040-02-01")).find((t) => t.id === task.id)?.next_due_on, "2040-02-29");
    });
    await t.test("yearly completions use the nearest occurrence and IDs sort numerically", async () => {
      await db.query("truncate upkeep_tasks cascade");
      for (const [month, day, done, expected] of [
        [12, 15, "2027-01-03", "2027-12-15"],
        [1, 5, "2026-12-20", "2028-01-05"],
        [1, 1, "2025-07-02", "2026-01-01"],
        [2, 29, "2024-02-29", "2025-02-28"],
        [2, 29, "2025-02-28", "2026-02-28"],
      ] as const) {
        const {
          rows: [task],
        } = await db.query(
          "insert into upkeep_tasks (name, category, yearly_month, yearly_day) values ('Synthetic', 'home', $1, $2) returning id::text",
          [month, day],
        );
        await logUpkeepCompletion(db, { request_id: randomUUID(), task_id: task.id, completed_on: done });
        assert.equal((await listUpkeep(db, "2030-01-01")).find((item) => item.id === task.id)?.next_due_on, expected);
      }
      await db.query("truncate upkeep_tasks cascade");
      for (let i = 0; i < 11; i++)
        await db.query("insert into upkeep_tasks (name, category, interval_months) values ('Synthetic', 'home', 1)");
      const ids = (await listUpkeep(db, "2030-01-01")).map((item) => BigInt(item.id));
      assert.deepEqual(
        ids,
        [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      );
      await assert.rejects(
        logUpkeepCompletion(db, { request_id: randomUUID(), task_id: String(ids[0]), completed_on: "2043-01-01" }),
        /future|today/i,
      );
    });
    await db.query(down);
    await db.query(up);
    await db.query(down);
  } finally {
    await db.query(`drop schema ${namespace} cascade`);
    await db.end();
  }
});

test("completion inputs reject malformed dates, ids and request ids", async () => {
  const { logUpkeepCompletionSchema } = await import("./upkeep.ts");
  const valid = { request_id: randomUUID(), task_id: "1", completed_on: "2041-01-01" };
  assert.equal(logUpkeepCompletionSchema.safeParse(valid).success, true);
  for (const patch of [
    { request_id: "bad" },
    { task_id: "0" },
    { task_id: "9223372036854775808" },
    { completed_on: "2041-02-30" },
    { completed_on: "1899-01-01" },
  ]) {
    assert.equal(logUpkeepCompletionSchema.safeParse({ ...valid, ...patch }).success, false);
  }
});
