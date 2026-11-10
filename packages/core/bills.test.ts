import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { billsDue } from "./bills.ts";

test("recorded charges own monthly and yearly billing cycles", {
  skip: !process.env.BILLS_TEST_DATABASE_URL,
}, async (t) => {
  const db = new pg.Client({ connectionString: process.env.BILLS_TEST_DATABASE_URL });
  await db.connect();
  try {
    await db.query("begin");
    const schema = await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8");
    await db.query(schema.replace(/^\\.*$/gm, ""));
    await db.query("set local search_path to public");
    for (const scenario of [
      {
        name: "early unpaid charge stays outside the window",
        from: "2041-01-12",
        due: 12,
        recorded: "2041-01-11",
        expected: [],
      },
      {
        name: "early paid cycle is not projected",
        from: "2041-01-12",
        due: 12,
        recorded: "2041-01-11",
        paid: true,
        expected: [],
      },
      {
        name: "shifted charge appears on its own date",
        from: "2041-01-12",
        due: 12,
        recorded: "2041-01-13",
        expected: [["Sun Jan 13", "80.00"]],
      },
      {
        name: "recorded charge appears even when scheduled day is outside the window",
        from: "2041-01-12",
        due: 25,
        recorded: "2041-01-13",
        expected: [["Sun Jan 13", "80.00"]],
      },
      {
        name: "later charge suppresses projection even outside the window",
        from: "2041-01-12",
        due: 12,
        recorded: "2041-01-25",
        expected: [],
      },
      {
        name: "missing cycle projects the last earlier charge",
        from: "2041-01-12",
        due: 12,
        recorded: "2040-12-11",
        paid: true,
        expected: [["Sat Jan 12", "80.00"]],
      },
      {
        name: "month-end projection clamps to leap day",
        from: "2040-02-27",
        due: 31,
        recorded: "2040-01-31",
        paid: true,
        expected: [["Wed Feb 29", "80.00"]],
      },
      {
        name: "non-leap month-end projection",
        from: "2041-02-27",
        due: 31,
        recorded: "2041-01-31",
        paid: true,
        expected: [["Thu Feb 28", "80.00"]],
      },
      {
        name: "yearly cycle includes charges in earlier months",
        from: "2041-03-01",
        due: 1,
        month: 3,
        recorded: "2041-02-28",
        expected: [],
      },
      {
        name: "early paid yearly cycle is not projected",
        from: "2041-03-01",
        due: 1,
        month: 3,
        recorded: "2041-02-28",
        paid: true,
        expected: [],
      },
      {
        name: "yearly recorded charge appears outside its scheduled month",
        from: "2041-02-27",
        due: 20,
        month: 3,
        recorded: "2041-02-28",
        expected: [["Thu Feb 28", "80.00"]],
      },
      {
        name: "missing yearly cycle projects last year's charge",
        from: "2041-03-01",
        due: 1,
        month: 3,
        recorded: "2040-02-28",
        paid: true,
        expected: [["Fri Mar 01", "80.00"]],
      },
      {
        name: "ended obligations have no bills",
        from: "2041-01-12",
        due: 12,
        recorded: "2041-01-13",
        ended: true,
        expected: [],
      },
    ]) {
      await t.test(scenario.name, async () => {
        await db.query("truncate charges, obligations restart identity cascade");
        await db.query(
          `insert into obligations (name, kind, cadence, due_day, due_month, day_is_estimate, ended_on)
          values ('Synthetic cycle', 'bill', $1, $2, $3, true, $4)`,
          [
            scenario.month ? "yearly" : "monthly",
            scenario.due,
            scenario.month ?? null,
            scenario.ended ? "2041-01-01" : null,
          ],
        );
        await db.query(
          `insert into charges (obligation_id, due_on, amount, paid_on)
          values (1, $1, 80.00, $2)`,
          [scenario.recorded, scenario.paid ? scenario.recorded : null],
        );
        const bills = await billsDue(db, scenario.from, 7);
        assert.deepEqual(
          bills.map((bill) => [bill.day, bill.amount]),
          scenario.expected,
        );
        for (const bill of bills) {
          assert.equal(bill.day_is_estimate, true);
          assert.equal(bill.amount_is_estimate, false);
        }
      });
    }
  } finally {
    await db.query("rollback");
    await db.end();
  }
});
