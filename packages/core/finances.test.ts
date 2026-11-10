import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { accounts, budgetTargets } from "./finances.ts";

test("finance records preserve account scope and monthly draft ranges", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("create schema finance_fixture");
    await db.query("set local search_path to finance_fixture");
    const migration = await readFile(
      new URL("../../db/migrations/20261110150000_accounts_budget_targets.sql", import.meta.url),
      "utf8",
    );
    const [up, down] = migration.split("-- migrate:down");
    assert.ok(up && down);
    await db.query(up);
    assert.deepEqual(await accounts(db), []);
    assert.deepEqual(await budgetTargets(db), []);
    await db.query(`
      insert into accounts (institution, name, kind, subtype, scope, notes) values
        ('Fixture bank', 'Operating', 'bank', 'checking', 'household', null),
        ('Fixture bank', 'Reserve', 'bank', 'savings', 'household', null),
        ('Fixture issuer', 'Purchases', 'card', null, 'business', null),
        ('Fixture broker', 'Holdings', 'investment', 'brokerage', 'unknown', 'Confirm scope'),
        ('Fixture lender', 'Borrowing', 'loan', null, 'household', null);
      insert into budget_targets (category, monthly_min, monthly_max, status, is_estimate) values
        ('Fixture groceries', 120.25, 160.75, 'draft', true),
        ('Fixture fuel', 50, 50, 'approved', false),
        ('Fixture paused', 0, 0, 'approved', false);
    `);
    const a = await accounts(db);
    assert.equal(a.length, 5);
    assert.deepEqual(
      a.find((row) => row.name === "Purchases"),
      {
        id: "3",
        institution: "Fixture issuer",
        name: "Purchases",
        kind: "card",
        subtype: null,
        scope: "business",
        notes: null,
      },
    );
    assert.equal(a.find((row) => row.name === "Holdings")?.scope, "unknown");
    assert.deepEqual(await budgetTargets(db), [
      {
        category: "Fixture fuel",
        monthly_min: "50.00",
        monthly_max: "50.00",
        status: "approved",
        is_estimate: false,
        notes: null,
      },
      {
        category: "Fixture groceries",
        monthly_min: "120.25",
        monthly_max: "160.75",
        status: "draft",
        is_estimate: true,
        notes: null,
      },
      {
        category: "Fixture paused",
        monthly_min: "0.00",
        monthly_max: "0.00",
        status: "approved",
        is_estimate: false,
        notes: null,
      },
    ]);
    for (const sql of [
      "insert into accounts (institution, name, kind, scope) values (' ', 'Invalid', 'bank', 'household')",
      "insert into accounts (institution, name, kind, scope) values ('Fixture', ' ', 'bank', 'household')",
      "insert into accounts (institution, name, kind, scope) values ('Fixture', 'Invalid', 'cash', 'household')",
      "insert into accounts (institution, name, kind, scope) values ('Fixture', 'Invalid', 'bank', 'both')",
      "insert into accounts (institution, name, kind, scope) values ('Fixture bank', 'Operating', 'bank', 'household')",
      "insert into budget_targets (category, monthly_min, monthly_max, status) values (' ', 1, 1, 'draft')",
      "insert into budget_targets (category, monthly_min, monthly_max, status) values ('Invalid', -1, 1, 'draft')",
      "insert into budget_targets (category, monthly_min, monthly_max, status) values ('Invalid', 2, 1, 'draft')",
      "insert into budget_targets (category, monthly_min, monthly_max, status) values ('Invalid', 1, 1, 'maybe')",
      "insert into budget_targets (category, monthly_min, monthly_max, status) values ('Invalid', 'NaN', 'NaN', 'draft')",
      "insert into budget_targets (category, monthly_min, monthly_max, status) values ('Fixture fuel', 1, 1, 'draft')",
    ]) {
      await db.query("savepoint invalid_row");
      await assert.rejects(db.query(sql), (error: unknown) => error instanceof pg.DatabaseError);
      await db.query("rollback to savepoint invalid_row");
    }
    await db.query(down);
    assert.equal((await db.query("select to_regclass('finance_fixture.accounts') as name")).rows[0].name, null);
    assert.equal((await db.query("select to_regclass('finance_fixture.budget_targets') as name")).rows[0].name, null);
    await db.query(up);
    assert.deepEqual(await accounts(db), []);
    assert.deepEqual(await budgetTargets(db), []);
  } finally {
    await db.query("rollback");
    await db.end();
  }
});
