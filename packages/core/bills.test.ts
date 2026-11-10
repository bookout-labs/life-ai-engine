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
        name: "two paid April charges claim distinct April and May cycles",
        from: "2041-04-28",
        due: 1,
        prior: "2041-04-01",
        recorded: "2041-04-16",
        paid: true,
        expected: [],
      },
      {
        name: "matching two charges takes priority over zero total distance",
        from: "2041-04-01",
        due: 1,
        recorded: "2041-04-16",
        paid: true,
        prior: "2041-05-01",
        expected: [],
      },
      {
        name: "minimum total distance leaves December due visible",
        from: "2040-12-26",
        due: 28,
        recorded: "2040-12-07",
        paid: true,
        prior: "2040-10-19",
        second: "2040-11-12",
        expected: [["Fri Dec 28", "80.00"]],
      },
      {
        name: "minimum total distance leaves April due visible",
        from: "2041-04-11",
        due: 14,
        recorded: "2041-05-31",
        paid: true,
        prior: "2041-06-23",
        second: "2041-05-20",
        expected: [["Sun Apr 14", null]],
      },
      {
        name: "surplus annual charge cannot claim next year",
        from: "2041-01-01",
        due: 6,
        month: 1,
        recorded: "2040-01-06",
        paid: true,
        prior: "2040-01-07",
        expected: [["Sun Jan 06", "80.00"]],
      },
      {
        name: "equal cost claims lexicographically earliest dates",
        from: "2041-11-14",
        days: 30,
        due: 30,
        recorded: "2041-11-13",
        paid: true,
        second: "2041-10-15",
        third: "2041-09-16",
        expected: [["Sat Nov 30", "80.00"]],
      },
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
        name: "ended obligations retain unpaid recorded bills",
        from: "2041-01-12",
        due: 12,
        recorded: "2041-01-13",
        ended: true,
        expected: [["Sun Jan 13", "80.00"]],
      },
      {
        name: "paid February charge in March does not consume March month end",
        from: "2041-03-28",
        due: 31,
        recorded: "2041-03-01",
        paid: true,
        prior: "2041-01-31",
        expected: [["Sun Mar 31", "80.00"]],
      },
      {
        name: "January charge on December 31 appears once on its own date",
        from: "2040-12-29",
        due: 1,
        recorded: "2040-12-31",
        prior: "2040-12-01",
        expected: [["Mon Dec 31", "80.00"]],
      },
      {
        name: "February charge on March 1 appears once on its own date",
        from: "2041-02-25",
        due: 31,
        recorded: "2041-03-01",

        expected: [["Fri Mar 01", "80.00"]],
      },
      {
        name: "early unpaid monthly charge claims next year",
        from: "2041-01-01",
        due: 1,
        recorded: "2040-12-31",

        expected: [],
      },
      {
        name: "early paid monthly charge claims next year",
        from: "2041-01-01",
        due: 1,
        recorded: "2040-12-31",
        paid: true,
        expected: [],
      },
      {
        name: "early unpaid annual charge claims next year",
        from: "2041-01-01",
        due: 5,
        recorded: "2040-12-28",
        month: 1,

        expected: [],
      },
      {
        name: "early paid annual charge claims next year",
        from: "2041-01-01",
        due: 5,
        recorded: "2040-12-28",
        month: 1,
        paid: true,
        expected: [],
      },
      {
        name: "paid charge inside the window is absent",
        from: "2041-01-12",
        due: 12,
        recorded: "2041-01-13",
        paid: true,
        expected: [],
      },
      {
        name: "window from the 28th projects dates in both months",
        from: "2041-01-28",
        due: 1,
        recorded: "2040-12-01",
        paid: true,
        expected: [["Fri Feb 01", "80.00"]],
      },
      {
        name: "monthly midpoint tie leaves upcoming bill projected",
        from: "2041-05-01",
        due: 1,
        recorded: "2041-04-16",
        paid: true,
        expected: [["Wed May 01", "80.00"]],
      },
      {
        name: "yearly midpoint tie leaves upcoming year projected",
        from: "2041-01-01",
        due: 1,
        recorded: "2040-07-02",
        month: 1,
        paid: true,
        expected: [["Tue Jan 01", "80.00"]],
      },
      {
        name: "ended obligations do not project missing bills",
        from: "2041-01-12",
        due: 12,
        recorded: "2040-12-12",
        ended: true,
        paid: true,
        expected: [],
      },
      {
        name: "two nearby charges both remain recorded",
        from: "2040-12-29",
        due: 1,
        recorded: "2040-12-31",
        second: "2041-01-01",
        expected: [
          ["Mon Dec 31", "80.00"],
          ["Tue Jan 01", "20.00"],
        ],
      },
      {
        name: "April midpoint charge leaves May bill projected",
        from: "2041-05-10",
        due: 15,
        prior: "2041-03-15",
        recorded: "2041-04-30",
        expected: [["Wed May 15", "80.00"]],
      },
      {
        name: "crowded January charges leave February projected",
        from: "2041-01-28",
        due: 1,
        prior: "2040-11-01",
        recorded: "2040-12-31",
        second: "2041-01-03",
        expected: [["Fri Feb 01", "20.00"]],
      },
      {
        name: "nearest matching preserves a missed December payment",
        from: "2040-11-28",
        due: 1,
        prior: "2040-11-01",
        recorded: "2040-12-31",
        second: "2041-01-03",
        expected: [["Sat Dec 01", "80.00"]],
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
            scenario.ended ? "2041-01-10" : null,
          ],
        );
        await db.query(
          `insert into charges (obligation_id, due_on, amount, paid_on)
          values (1, $1, 80.00, $2)`,
          [scenario.recorded, scenario.paid ? scenario.recorded : null],
        );
        if (scenario.prior) {
          await db.query("insert into charges (obligation_id, due_on, amount, paid_on) values (1, $1, 80.00, $1)", [
            scenario.prior,
          ]);
        }
        if (scenario.second) {
          await db.query("insert into charges (obligation_id, due_on, amount) values (1, $1, 20.00)", [
            scenario.second,
          ]);
        }
        if (scenario.third) {
          await db.query("insert into charges (obligation_id, due_on, amount) values (1, $1, 20.00)", [scenario.third]);
        }
        const bills = await billsDue(db, scenario.from, scenario.days ?? 7);
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
