import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { buildSpending, importSpending, readSpending, type SpendingTransaction } from "./spending.ts";
import { fromConnector } from "./spending-import.ts";

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
    buildSpending(
      [charge("coverage", "1.00", { posted_on: "2039-11-01", merchant: "History coverage" }), ...rows],
      [],
      { month: "2040-02", category: "Synthetic category" },
      "2040-02-15",
    ).unusual;
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
  const namespace = `spending_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await db.query(`create schema ${namespace}`);
    const schema = await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8");
    await db.query(schema.replace(/^\\.*$/gm, "").replaceAll(/\bpublic\b/g, namespace));
    await db.query(`set search_path to ${namespace}`);
    await t.test("reversed concurrent imports succeed with overlapping keys", async () => {
      const other = new Client({ connectionString: process.env.SPENDING_TEST_DATABASE_URL });
      await other.connect();
      await other.query(`set search_path to ${namespace}`);
      try {
        await db.query(
          "create function slow_import() returns trigger language plpgsql as $$ begin perform pg_sleep(0.05); return new; end $$; create trigger slow_import before insert on transactions for each row execute function slow_import()",
        );
        const rows = [charge("concurrent-a", "1.00"), charge("concurrent-b", "2.00")];
        await Promise.all([importSpending(db, rows), importSpending(other, rows.toReversed())]);
        assert.equal((await readSpending(db, { month: "2040-02" }, "2040-02-29")).total, "3.00");
      } finally {
        await other.end();
        await db.query(
          "drop trigger slow_import on transactions; drop function slow_import(); delete from transactions",
        );
      }
    });
    await t.test("identical reimports update nothing and corrections are counted", async () => {
      assert.deepEqual(await importSpending(db, [charge("count", "1.00")]), {
        processed: 1,
        inserted: 1,
        updated: 0,
        excluded: 0,
      });
      assert.deepEqual(await importSpending(db, [charge("count", "1.00")]), {
        processed: 1,
        inserted: 0,
        updated: 0,
        excluded: 0,
      });
      assert.deepEqual(await importSpending(db, [charge("count", "2.00", { exclusion_reason: "transfer" })]), {
        processed: 1,
        inserted: 0,
        updated: 1,
        excluded: 1,
      });
      await db.query("delete from transactions");
    });
    await t.test("connector pages reimport without updates and excluded income cannot inflate totals", async () => {
      const rows = fromConnector(
        [
          { id: "1", amount: -50, category: "Food" },
          { id: "2", amount: 10, category: "Food" },
          { id: "3", amount: 5000, category: "Other Income" },
          { id: "4", amount: 300, category: "Business Income" },
          { id: "5", amount: 40, category: "Balance Adjustments" },
        ].map((row) => ({
          ...row,
          date: "2040-02-01",
          pending: false,
          merchant: "Synthetic merchant",
          merchant_id: "6",
          formatted_amount: "",
          category_id: "7",
          account: "Synthetic account",
          account_id: "8",
        })),
        { source: "monarch" },
      );
      assert.deepEqual(await importSpending(db, rows), { processed: 5, inserted: 5, updated: 0, excluded: 3 });
      assert.deepEqual(await importSpending(db, rows), { processed: 5, inserted: 0, updated: 0, excluded: 3 });
      assert.equal((await readSpending(db, { month: "2040-02" }, "2040-02-29")).total, "40.00");
      await db.query("delete from transactions");
    });
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
      charge("coverage", "1.00", { posted_on: "2039-11-01", merchant: "History coverage" }),
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
    await db.query(`drop schema ${namespace} cascade`);
    await db.end();
  }
});

test("first-seen is suppressed until each source has 90 days of loaded history", () => {
  const current = charge("new", "150.00", { merchant: "New synthetic" });
  const report = (history: SpendingTransaction[]) =>
    buildSpending([...history, current], [], { month: "2040-02" }, "2040-02-15");
  assert.deepEqual(report([]).unusual, []);
  assert.match(report([]).notes.join(" "), /first.seen.*suppress/i);
  assert.deepEqual(report([charge("short", "1.00", { posted_on: "2039-11-04" })]).unusual, []);
  assert.equal(report([charge("old", "1.00", { posted_on: "2039-11-03" })]).unusual[0]?.rule, "first_seen");
  assert.deepEqual(report([charge("other", "1.00", { source: "other", posted_on: "2039-01-01" })]).unusual, []);
});
test("category filters ignore surrounding whitespace and case", () => {
  const result = buildSpending(
    [charge("a", "12.34")],
    [target],
    { month: "2040-02", category: "  SYNTHETIC CATEGORY " },
    "2040-02-15",
  );
  assert.equal(result.total, "12.34");
  assert.equal(result.categories[0]?.target?.monthly_max, "580.00");
});

test("household spending excludes business accounts but includes unknown and unmapped accounts", {
  skip: !process.env.SPENDING_TEST_DATABASE_URL,
}, async () => {
  const db = new Client({ connectionString: process.env.SPENDING_TEST_DATABASE_URL });
  await db.connect();
  const namespace = `household_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await db.query(`create schema ${namespace}`);
    const schema = await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8");
    await db.query(schema.replace(/^\\.*$/gm, "").replaceAll(/\bpublic\b/g, namespace));
    await db.query(`set search_path to ${namespace}`);
    await db.query(`insert into accounts(institution, name, kind, scope, source_ref) values
      ('Synthetic bank', 'Household', 'card', 'household', 'home-card'),
      ('Synthetic bank', 'Business', 'card', 'business', 'work-card'),
      ('Synthetic bank', 'Unknown', 'card', 'unknown', 'unknown-card'),
      ('Synthetic bank', 'Unmapped business', 'card', 'business', null)`);
    await db.query(`insert into budget_targets(category, monthly_min, monthly_max, status)
      values ('Synthetic category', 290, 580, 'approved')`);
    await importSpending(db, [
      charge("home", "10.00", { account_ref: "home-card" }),
      charge("work", "1000.00", { account_ref: "work-card", merchant: "Synthetic business" }),
      charge("unknown", "20.00", { account_ref: "unknown-card" }),
      charge("unmapped", "30.00", { account_ref: "unmapped-card" }),
    ]);
    const result = await readSpending(db, { month: "2040-02" }, "2040-02-15");
    assert.equal(result.total, "60.00");
    assert.equal(result.categories[0]?.spend, "60.00");
    assert.equal(result.categories[0]?.target?.paced_max, "300.00");
    assert.equal(result.categories[0]?.target?.above_pace, false);
    assert.deepEqual(result.top_merchants, [{ merchant: "Synthetic shop", spend: "60.00" }]);
    assert.deepEqual(result.unusual, []);
    await db.query("update accounts set scope = 'unknown' where source_ref = 'work-card'");
    const reclassified = await readSpending(db, { month: "2040-02" }, "2040-02-15");
    assert.equal(reclassified.total, "1060.00");
    assert.equal(reclassified.categories[0]?.target?.above_pace, true);
    for (const source_ref of ["", " ", " work-card", "work-card ", "work-card"]) {
      await assert.rejects(
        db.query(
          "insert into accounts(institution, name, kind, scope, source_ref) values ('Synthetic bank', 'Invalid mapping', 'card', 'business', $1)",
          [source_ref],
        ),
      );
    }
    await db.query(`insert into accounts(institution, name, kind, scope)
      values ('Synthetic bank', 'Another unmapped account', 'card', 'household')`);
  } finally {
    await db.query(`drop schema ${namespace} cascade`);
    await db.end();
  }
});
