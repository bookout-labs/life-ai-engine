import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { investmentBuys } from "./investment-buys.ts";

test("investment buys enforce states and report remaining and completed rows", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  try {
    const migration = await readFile(
      new URL("../../db/migrations/20261110120000_investment_buys.sql", import.meta.url),
      "utf8",
    );
    const [up, down] = migration.split("-- migrate:down");
    assert.ok(up && down);
    await db.query(up.replaceAll("create table ", "create temp table "));
    assert.deepEqual(await investmentBuys(db), { planned: [], completed: [] });
    await db.query(
      `insert into investment_buys (state, symbol, account_ref, planned_on, amount) values ('planned', 'ABC', 'fixture account', '2030-01-01', 100)`,
    );
    await db.query(
      `insert into investment_buys (state, symbol, account_ref, planned_condition) values ('planned', 'XYZ', 'fixture account', 'when ready')`,
    );
    await db.query(
      `insert into investment_buys (state, symbol, account_ref, executed_on, amount) values ('completed', 'ABC', 'fixture account', '2030-01-02', 99.50)`,
    );
    const result = await investmentBuys(db);
    assert.equal(result.planned.length, 2);
    assert.equal(result.completed.length, 1);
    assert.equal(result.completed[0]?.amount, "99.50");
    for (const values of [
      "('planned', 'ABC', 'fixture account', null, null, null)",
      "('planned', 'ABC', 'fixture account', '2030-01-01', '2030-01-02', 10)",
      "('completed', 'ABC', 'fixture account', null, null, 10)",
      "('completed', 'ABC', 'fixture account', null, '2030-01-02', null)",
      "('completed', 'ABC', 'fixture account', null, '2030-01-02', 0)",
    ]) {
      await assert.rejects(
        db.query(
          `insert into investment_buys (state, symbol, account_ref, planned_on, executed_on, amount) values ${values}`,
        ),
      );
    }

    await db.query("delete from investment_buys");
    for (const id of [11, 2, 10])
      await db.query(
        "insert into investment_buys(id, state, symbol, account_ref, planned_on) overriding system value values ($1, 'planned', 'ABC', 'Fixture', '2040-01-01')",
        [id],
      );
    assert.deepEqual(
      (await investmentBuys(db)).planned.map((buy) => buy.id),
      ["2", "10", "11"],
    );
    await db.query(down);
    await assert.rejects(investmentBuys(db));
  } finally {
    await db.query("drop table if exists investment_buys");
    await db.end();
  }
});
