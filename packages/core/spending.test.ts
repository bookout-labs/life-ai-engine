import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { buildSpending, importSpending, readSpending, type SpendingTransaction } from "./spending.ts";

function charge(source_id: string, amount = "10.00", extra: Partial<SpendingTransaction> = {}): SpendingTransaction {
  return {
    source: "synthetic",
    source_id,
    posted_on: "2040-02-01",
    amount,
    merchant: "Synthetic shop",
    category: "Synthetic category",
    account_ref: "synthetic-account",
    pending: false,
    exclusion_reason: null,
    ...extra,
  };
}
const target = {
  category: "Synthetic category",
  monthly_min: "290.00",
  monthly_max: "580.00",
  status: "draft",
  is_estimate: true,
  notes: null,
} satisfies Parameters<typeof buildSpending>[1][number];

test("exact net spend excludes pending and transfers and respects month and category boundaries", () => {
  const rows = [
    charge("a", "0.10"),
    charge("b", "0.20"),
    charge("c", "-0.05"),
    charge("pending", "100.00", { pending: true }),
    charge("transfer", "100.00", { exclusion_reason: "transfer" }),
    charge("hidden", "100.00", { exclusion_reason: "hidden" }),
    charge("income", "100.00", { exclusion_reason: "income" }),
    charge("previous", "100.00", { posted_on: "2040-01-31" }),
    charge("next", "100.00", { posted_on: "2040-03-01" }),
    charge("future", "100.00", { posted_on: "2040-02-16" }),
    charge("other", "1.00", { category: "Other synthetic" }),
  ];
  const result = buildSpending(rows, [target], { month: "2040-02", category: target.category }, "2040-02-15");
  assert.equal(result.total, "0.25");
  assert.equal(result.categories.length, 1);
  assert.equal(result.top_merchants[0]?.spend, "0.25");
  assert.deepEqual(result.categories[0]?.target, {
    monthly_min: "290.00",
    monthly_max: "580.00",
    status: "draft",
    is_estimate: true,
    paced_min: "150.00",
    paced_max: "300.00",
    above_pace: false,
  });
  assert.equal(buildSpending([charge("refund", "-1.23")], [], { month: "2040-02" }, "2040-02-15").total, "-1.23");
});

test("pace clamps past and future months, rounds cents, and preserves missing or approved targets", () => {
  assert.equal(buildSpending([], [target], { month: "2040-02" }, "2040-01-31").days_elapsed, 0);
  const past = buildSpending(
    [charge("a", "600.00")],
    [{ ...target, status: "approved" }],
    { month: "2040-02" },
    "2040-03-10",
  );
  assert.equal(past.days_elapsed, 29);
  assert.equal(past.categories[0]?.target?.paced_max, "580.00");
  assert.equal(past.categories[0]?.target?.above_pace, true);
  assert.equal(past.categories[0]?.target?.status, "approved");
  assert.equal(buildSpending([charge("a")], [], { month: "2040-02" }, "2040-02-01").categories[0]?.target, null);
  assert.equal(
    buildSpending([], [{ ...target, monthly_min: "1.00", monthly_max: "1.00" }], { month: "2040-02" }, "2040-02-01")
      .categories[0]?.target?.paced_max,
    "0.03",
  );
});

test("above-typical cue uses prior-month median, minimum sample, and inclusive floor and multiple", () => {
  const history = [
    charge("h1", "20.00", { posted_on: "2040-01-01" }),
    charge("h2", "30.00", { posted_on: "2040-01-02" }),
    charge("h3", "40.00", { posted_on: "2040-01-03" }),
    charge("h4", "50.00", { posted_on: "2040-01-04" }),
  ];
  const report = (rows: SpendingTransaction[], amount: string) =>
    buildSpending([...rows, charge("current", amount)], [], { month: "2040-02" }, "2040-02-15").unusual;
  assert.equal(report(history, "105.00")[0]?.rule, "above_typical");
  assert.deepEqual(report(history, "104.99"), []);
  assert.deepEqual(report(history.slice(0, 2), "500.00"), []);
  assert.deepEqual(
    report(
      history.map((row) => ({ ...row, amount: "1.00" })),
      "99.99",
    ),
    [],
  );
  assert.equal(report(history.slice(0, 3), "100.00")[0]?.rule, "above_typical");
  assert.deepEqual(
    report(
      history.map((row) => ({ ...row, pending: true })),
      "99.99",
    ),
    [],
  );
  assert.equal(report(history, "-500.00").length, 0);
});

test("first-seen cue requires the floor and no earlier positive eligible charge across categories", () => {
  const report = (rows: SpendingTransaction[]) =>
    buildSpending(rows, [], { month: "2040-02", category: "Synthetic category" }, "2040-02-15").unusual;
  assert.equal(report([charge("a", "100.00")])[0]?.rule, "first_seen");
  assert.deepEqual(report([charge("a", "99.99")]), []);
  assert.deepEqual(
    report([charge("a", "100.00"), charge("before", "1.00", { posted_on: "2040-01-31", category: "Other synthetic" })]),
    [],
  );
  assert.equal(report([charge("a", "100.00"), charge("z", "150.00")]).length, 1);
  assert.equal(
    report([charge("a", "100.00"), charge("pending", "1.00", { posted_on: "2040-01-01", pending: true })]).length,
    1,
  );
  assert.equal(
    report([
      charge("a", "100.00"),
      charge("transfer", "1.00", { posted_on: "2040-01-01", exclusion_reason: "transfer" }),
    ]).length,
    1,
  );
});

test("merchant ranking is numeric, deterministic and limited to ten", () => {
  const rows = Array.from({ length: 12 }, (_, i) => charge(String(i), `${i + 1}.00`, { merchant: `Synthetic ${i}` }));
  const result = buildSpending(rows, [], { month: "2040-02" }, "2040-02-15");
  assert.equal(result.total, "78.00");
  assert.equal(result.top_merchants.length, 10);
  assert.deepEqual(result.top_merchants[0], { merchant: "Synthetic 11", spend: "12.00" });
});

test("disposable database imports converge, corrections replace values, invalid batches are atomic, Chicago date freezes month end", {
  skip: !process.env.SPENDING_TEST_DATABASE_URL,
}, async (t) => {
  const db = new Client({ connectionString: process.env.SPENDING_TEST_DATABASE_URL });
  await db.connect();
  try {
    const schema = await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8");
    await db.query(schema.replace(/^\\.*$/gm, ""));
    await db.query("set search_path to public");
    await importSpending(db, [
      charge("a", "0.10"),
      charge("b", "0.20"),
      charge("p", "500.00", { pending: true }),
      charge("t", "500.00", { exclusion_reason: "transfer" }),
      charge("boundary", "1.00", { posted_on: "2040-03-01" }),
    ]);
    await importSpending(db, [charge("a", "0.10"), charge("b", "0.20")]);
    assert.equal((await readSpending(db, { month: "2040-02" }, "2040-02-29")).total, "0.30");
    await importSpending(db, [charge("a", "0.40", { category: "Corrected synthetic" })]);
    assert.equal((await readSpending(db, { month: "2040-02" }, "2040-02-29")).total, "0.60");
    assert.equal(
      (await readSpending(db, { month: "2040-02", category: "Corrected synthetic" }, "2040-02-29")).total,
      "0.40",
    );
    await assert.rejects(importSpending(db, [charge("bad", "1.001")]));
    await assert.rejects(
      importSpending(db, [charge("a", "10.00"), charge("bad", "1.00", { merchant: "bad\u0000merchant" })]),
    );
    assert.equal((await readSpending(db, { month: "2040-02" }, "2040-02-29")).total, "0.60");
    await db.query(`insert into budget_targets (category, monthly_min, monthly_max, status)
      values ('Corrected synthetic', 29.00, 58.00, 'draft')`);
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2040-03-01T05:59:59Z") });
    const before = await readSpending(db, { month: "2040-02" });
    assert.equal(before.as_of, "2040-02-29");
    assert.equal(before.total, "0.60");
    assert.equal(before.categories.find((row) => row.category === "Corrected synthetic")?.target?.paced_max, "58.00");
    t.mock.timers.setTime(new Date("2040-03-01T06:00:00Z").getTime());
    const after = await readSpending(db, { month: "2040-03" });
    assert.equal(after.as_of, "2040-03-01");
    assert.equal(after.total, "1.00");
    const history = [
      charge("h1", "20.00", { posted_on: "2040-01-01" }),
      charge("h2", "30.00", { posted_on: "2040-01-02" }),
      charge("h3", "40.00", { posted_on: "2040-01-03" }),
      charge("large", "100.00"),
      charge("new", "100.00", { merchant: "Synthetic new merchant" }),
      charge("small", "99.99", { merchant: "Synthetic small merchant" }),
      charge("refund", "-0.05"),
    ];
    await importSpending(db, history);
    const cues = await readSpending(db, { month: "2040-02" }, "2040-02-29");
    assert.deepEqual(cues.unusual.map((row) => row.rule).sort(), ["above_typical", "first_seen"]);
    assert.equal(cues.total, "300.54");
    await assert.rejects(readSpending(db, { month: "2040-13" }));
    await assert.rejects(readSpending(db, { month: "2040-02" }, "not-a-date"));
  } finally {
    await db.end();
  }
});
