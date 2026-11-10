import assert from "node:assert/strict";
import test from "node:test";
import { buildMoneyCheck, type MoneyCharge, type MoneyObligation, readMoneyCheck } from "./money-check.ts";

const obligation: MoneyObligation = {
  id: "1",
  name: "Synthetic bill",
  cadence: "monthly",
  due_day: null,
  due_month: null,
  day_is_estimate: false,
  pays_from: null,
  ended_on: null,
};
function charge(due_on: string, amount = "10.00", extra: Partial<MoneyCharge> = {}): MoneyCharge {
  return { obligation_id: "1", due_on, amount, amount_is_estimate: false, paid_on: null, ...extra };
}

test("seven-day window includes today and day six, preserves estimates, and totals exact cents", () => {
  const result = buildMoneyCheck(
    [obligation],
    [
      charge("2040-01-09", "0.10"),
      charge("2040-01-10", "0.20"),
      charge("2040-01-16", "0.10", { amount_is_estimate: true }),
      charge("2040-01-17"),
      charge("2040-01-08", "50.00", { paid_on: "2040-01-09" }),
    ],
    "2040-01-10",
  );
  assert.deepEqual(
    result.due_soon.map((entry) => [entry.due_on, entry.amount_is_estimate]),
    [
      ["2040-01-10", false],
      ["2040-01-16", true],
    ],
  );
  assert.deepEqual(
    result.overdue.map((entry) => entry.due_on),
    ["2040-01-09"],
  );
  assert.deepEqual(result.totals, { due_soon: "0.30", overdue: "0.10", due_soon_unknown: 0 });
});

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
      ).price_increases,
      [],
    );
  }
  assert.equal(
    buildMoneyCheck([obligation], [charge("2040-01-01", "0.00"), charge("2040-01-02", "1.00")], "2040-01-10")
      .price_increases[0]?.percent,
    null,
  );
  assert.equal(
    buildMoneyCheck([obligation], [charge("2040-01-01", "3.00"), charge("2040-01-02", "4.00")], "2040-01-10")
      .price_increases[0]?.percent,
    "33.33",
  );
});

test("ended obligations never appear in any list", () => {
  const result = buildMoneyCheck(
    [{ ...obligation, due_day: 10, ended_on: "2040-01-01" }],
    [charge("2039-12-10"), charge("2040-01-10", "15.00")],
    "2040-01-10",
  );
  assert.deepEqual(result.due_soon, []);
  assert.deepEqual(result.overdue, []);
  assert.deepEqual(result.price_increases, []);
});

test("calendar bills clamp month ends, respect annual month, and disclose projected or unknown amounts", () => {
  const result = buildMoneyCheck(
    [
      { ...obligation, due_day: 31, day_is_estimate: true },
      { ...obligation, id: "2", due_day: 1, cadence: "yearly", due_month: 3 },
      { ...obligation, id: "3", due_day: 1, cadence: "yearly", due_month: 4 },
    ],
    [charge("2040-01-31", "12.34", { paid_on: "2040-01-31" })],
    "2040-02-27",
  );
  assert.deepEqual(
    result.due_soon.map((entry) => [
      entry.obligation_id,
      entry.due_on,
      entry.amount,
      entry.amount_is_estimate,
      entry.day_is_estimate,
    ]),
    [
      ["1", "2040-02-29", "12.34", true, true],
      ["2", "2040-03-01", null, true, false],
    ],
  );
  assert.deepEqual(result.totals, { due_soon: "12.34", overdue: "0.00", due_soon_unknown: 1 });
});

test("recorded charge replaces projection and a paid occurrence is excluded", () => {
  for (const paid_on of [null, "2040-01-10"]) {
    const result = buildMoneyCheck(
      [{ ...obligation, due_day: 10 }],
      [charge("2039-12-10", "10.00", { paid_on: "2039-12-10" }), charge("2040-01-10", "15.00", { paid_on })],
      "2040-01-10",
    );
    assert.deepEqual(
      result.due_soon.map((entry) => [entry.amount, entry.amount_is_estimate]),
      paid_on === null ? [["15.00", false]] : [],
    );
  }
});

test("database snapshot reads active obligations and today includes the money check", {
  skip: !process.env.MONEY_CHECK_TEST_DATABASE_URL,
}, async () => {
  const { Client } = await import("pg");
  const { readFile } = await import("node:fs/promises");
  const { readToday } = await import("./today.ts");
  const db = new Client({ connectionString: process.env.MONEY_CHECK_TEST_DATABASE_URL });
  await db.connect();
  try {
    const schema = await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8");
    await db.query(schema.replace(/^\\.*$/gm, ""));
    await db.query("set search_path to public");
    await db.query(`insert into obligations (name, kind, cadence, due_day) values
      ('Synthetic bill', 'bill', 'monthly', 10);
      insert into charges (obligation_id, due_on, amount, paid_on) values
      (1, '2039-12-10', 10.00, '2039-12-10'), (1, '2040-01-10', 12.50, null);
      insert into charges (obligation_id, due_on, amount, amount_is_estimate) values
      (1, '2040-01-09', 9.99, true);`);
    const result = await readMoneyCheck(db, "2040-01-10");
    assert.deepEqual(result.totals, { due_soon: "12.50", overdue: "9.99", due_soon_unknown: 0 });
    assert.equal(result.price_increases[0]?.percent, "25.00");
    const daily = await readToday(db, "2040-01-10T12:00:00Z");
    assert.deepEqual(daily.money_check, result);
    await assert.rejects(readMoneyCheck(db, "bad-date"));
    await db.query("update obligations set ended_on = '2040-01-10'");
    assert.deepEqual((await readMoneyCheck(db, "2040-01-10")).due_soon, []);
  } finally {
    await db.end();
  }
});
