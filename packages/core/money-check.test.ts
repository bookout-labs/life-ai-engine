import assert from "node:assert/strict";
import test from "node:test";
import { buildMoneyCheck, type MoneyCharge, type MoneyObligation, readMoneyCheck } from "./money-check.ts";

const obligation: MoneyObligation = {
  id: "1",
  name: "Synthetic bill",
  day_is_estimate: false,
  pays_from: null,
  ended_on: null,
};
function charge(due_on: string, amount = "10.00", extra: Partial<MoneyCharge> = {}): MoneyCharge {
  return { obligation_id: "1", due_on, amount, amount_is_estimate: false, paid_on: null, ...extra };
}

test("latest confirmed price compares with its predecessor, skipping estimates and future charges", () => {
  const result = buildMoneyCheck(
    [obligation],
    [
      charge("2039-12-01", "20.00"),
      charge("2040-01-01", "25.00", { paid_on: "2040-01-01" }),
      charge("2039-12-20", "100.00", { amount_is_estimate: true }),
      charge("2040-02-01", "30.00"),
    ],
    "2040-01-10",
    [],
  );
  assert.deepEqual(result.price_increases, [
    {
      obligation_id: "1",
      name: "Synthetic bill",
      previous_due_on: "2039-12-01",
      due_on: "2040-01-01",
      old_amount: "20.00",
      new_amount: "25.00",
      percent: "25.00",
    },
  ]);
  for (const amounts of [["10.00"], ["10.00", "10.00"], ["10.00", "9.00"], ["0.00", "0.00"]]) {
    assert.deepEqual(
      buildMoneyCheck(
        [obligation],
        amounts.map((amount, i) => charge(`2040-01-0${i + 1}`, amount)),
        "2040-01-10",
        [],
      ).price_increases,
      [],
    );
  }
  assert.equal(
    buildMoneyCheck([obligation], [charge("2040-01-01", "0.00"), charge("2040-01-02", "1.00")], "2040-01-10", [])
      .price_increases[0]?.percent,
    null,
  );
  assert.equal(
    buildMoneyCheck([obligation], [charge("2040-01-01", "3.00"), charge("2040-01-02", "4.00")], "2040-01-10", [])
      .price_increases[0]?.percent,
    "33.33",
  );
});

test("price increases expire after 60 days, including the boundary day", () => {
  const history = [charge("2039-10-01", "10.00"), charge("2039-11-11", "12.00")];
  assert.equal(buildMoneyCheck([obligation], history, "2040-01-10", []).price_increases.length, 1);
  assert.deepEqual(buildMoneyCheck([obligation], history, "2040-01-11", []).price_increases, []);
});

test("due-soon uses supplied bills, preserves flags and nulls, and sums decimal cents", () => {
  const bills = [
    {
      day: "Tue Jan 10",
      name: "Synthetic A",
      amount: "0.10",
      amount_is_estimate: false,
      day_is_estimate: false,
      pays_from: null,
    },
    {
      day: "Wed Jan 11",
      name: "Synthetic B",
      amount: "0.20",
      amount_is_estimate: true,
      day_is_estimate: true,
      pays_from: null,
    },
    {
      day: "Thu Jan 12",
      name: "Synthetic C",
      amount: null,
      amount_is_estimate: false,
      day_is_estimate: false,
      pays_from: null,
    },
  ];
  const result = buildMoneyCheck([], [], "2040-01-10", bills);
  assert.deepEqual(result.due_soon, bills);
  assert.deepEqual(result.totals, { due_soon: "0.30", overdue: "0.00", due_soon_unknown: 1 });
});

test("overdue includes day 60, counts older unpaid separately, and ignores paid stale charges", () => {
  const result = buildMoneyCheck(
    [obligation],
    [
      charge("2039-11-10", "100.00"),
      charge("2039-11-11", "0.10"),
      charge("2040-01-09", "0.20"),
      charge("2039-11-01", "50.00", { paid_on: "2039-11-02" }),
    ],
    "2040-01-10",
    [],
  );
  assert.deepEqual(
    result.overdue.map((entry) => entry.due_on),
    ["2039-11-11", "2040-01-09"],
  );
  assert.equal(result.totals.overdue, "0.30");
  assert.equal(result.stale_unpaid, 1);
});

test("database bills and money check agree, and today carries only the money summary", {
  skip: !process.env.MONEY_CHECK_TEST_DATABASE_URL,
}, async () => {
  const { Client } = await import("pg");
  const { readFile } = await import("node:fs/promises");
  const { readToday } = await import("./today.ts");
  const { billsDue } = await import("./bills.ts");
  const db = new Client({ connectionString: process.env.MONEY_CHECK_TEST_DATABASE_URL });
  await db.connect();
  try {
    const schema = await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8");
    await db.query(schema.replace(/^\\.*$/gm, ""));
    await db.query("set search_path to public");
    await db.query(`insert into obligations (name, kind, cadence, due_day, day_is_estimate)
      values ('Synthetic off-day', 'bill', 'monthly', 12, true);
      insert into charges (obligation_id, due_on, amount) values (1, '2041-01-11', 80.00);`);
    const offDay = await readToday(db, "2041-01-12T12:00:00Z");
    assert.ok(offDay.money_check);
    assert.deepEqual(offDay.money_check.totals, { due_soon: "0.00", overdue: "80.00", due_soon_unknown: 0 });
    assert.deepEqual(offDay.bills, []);
    assert.deepEqual(
      offDay.money_check.overdue.map((entry) => [entry.due_on, entry.amount]),
      [["2041-01-11", "80.00"]],
    );
    await db.query("truncate charges, obligations restart identity cascade");
    await db.query(`insert into obligations (name, kind, cadence, due_day, day_is_estimate) values
      ('Synthetic A', 'bill', 'monthly', 10, false),
      ('Synthetic B', 'bill', 'monthly', 16, true),
      ('Synthetic C', 'bill', 'monthly', 17, false),
      ('Synthetic D', 'bill', 'monthly', 12, false);
      insert into charges (obligation_id, due_on, amount, paid_on, amount_is_estimate) values
      (1, '2039-12-10', 0.10, '2039-12-10', false),
      (1, '2040-01-10', 0.20, null, false),
      (2, '2039-12-16', 0.10, '2039-12-16', true),
      (3, '2039-12-17', 20.00, '2039-12-17', false),
      (1, '2039-11-10', 100.00, null, true),
      (1, '2039-11-11', 0.10, null, true),
      (1, '2040-01-09', 0.20, null, true);`);
    const result = await readMoneyCheck(db, "2040-01-10");
    assert.deepEqual(result.due_soon, await billsDue(db, "2040-01-10", 7));
    assert.deepEqual(
      result.due_soon.map((b) => [b.name, b.amount, b.amount_is_estimate, b.day_is_estimate]),
      [
        ["Synthetic A", "0.20", false, false],
        ["Synthetic D", null, false, false],
        ["Synthetic B", "0.10", true, true],
      ],
    );
    assert.deepEqual(result.totals, { due_soon: "0.30", overdue: "0.30", due_soon_unknown: 1 });
    assert.equal(result.through, "2040-01-16");
    assert.equal(result.stale_unpaid, 1);
    assert.equal(result.price_increases[0]?.percent, "100.00");
    const { due_soon, ...summary } = result;
    const daily = await readToday(db, "2040-01-10T12:00:00Z");
    assert.deepEqual(daily.bills, due_soon);
    assert.deepEqual(daily.money_check, summary);
    assert.equal("due_soon" in daily.money_check, false);
    await assert.rejects(readMoneyCheck(db, "bad-date"));
    await db.query("update charges set paid_on = '2040-01-10' where due_on = '2040-01-10'");
    assert.equal(
      (await readMoneyCheck(db, "2040-01-10")).due_soon.some((b) => b.name === "Synthetic A"),
      false,
    );
    await db.query("update obligations set ended_on = '2040-01-10'");
    const ended = await readMoneyCheck(db, "2040-01-10");
    assert.deepEqual(ended.due_soon, []);
    assert.deepEqual(
      ended.overdue.map((entry) => entry.due_on),
      ["2039-11-11", "2040-01-09"],
    );
    assert.deepEqual(ended.price_increases, []);
    assert.equal(ended.stale_unpaid, 1);

    await db.query(`truncate charges, obligations restart identity cascade;
      insert into obligations (name, kind, cadence, due_day, due_month) values
      ('Synthetic month end', 'bill', 'monthly', 31, null),
      ('Synthetic annual', 'bill', 'yearly', 1, 3),
      ('Synthetic other month', 'bill', 'yearly', 1, 4);
      insert into charges (obligation_id, due_on, amount, paid_on) values
      (1, '2040-01-31', 12.34, '2040-01-31');`);
    const calendar = await readMoneyCheck(db, "2040-02-27");
    assert.deepEqual(calendar.due_soon, await billsDue(db, "2040-02-27", 7));
    assert.deepEqual(
      calendar.due_soon.map((b) => [b.day, b.name, b.amount, b.amount_is_estimate]),
      [
        ["Wed Feb 29", "Synthetic month end", "12.34", false],
        ["Thu Mar 01", "Synthetic annual", null, false],
      ],
    );
    assert.deepEqual(calendar.totals, { due_soon: "12.34", overdue: "0.00", due_soon_unknown: 1 });
  } finally {
    await db.end();
  }
});
