import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { ZodError } from "zod";
import { readGifts, recordGiftInputSchema, writeGift, writeGiftSchema } from "./gifts.ts";

test("flat gift input preserves all five commands and their required fields", () => {
  const base = { request_id: randomUUID(), occasion_id: "fixture" };
  const gift = { ...base, recipient_id: "1", idea: "Fixture", amount: "0.00", status: "idea" };
  const commands = [
    { ...base, action: "occasion", title: "Fixture", budget: null },
    { ...base, action: "recipient", member_id: "1", budget: null },
    { ...gift, action: "add_gift" },
    { ...gift, action: "update_gift", gift_id: randomUUID() },
    { request_id: randomUUID(), action: "status", gift_id: randomUUID(), status: "bought" },
  ];
  for (const command of commands) {
    assert.deepEqual(writeGiftSchema.parse(recordGiftInputSchema.parse(command)), writeGiftSchema.parse(command));
    for (const key of Object.keys(command)) {
      const incomplete = { ...command, [key]: undefined };
      assert.throws(() => writeGiftSchema.parse(incomplete), ZodError, `${command.action} requires ${key}`);
      assert.throws(
        () => writeGiftSchema.parse(recordGiftInputSchema.parse(incomplete)),
        ZodError,
        `flat input still requires ${command.action}.${key}`,
      );
    }
  }
});

test("gift commands reject incomplete recipients, invalid money and unknown statuses", () => {
  const input = {
    action: "add_gift",
    request_id: randomUUID(),
    occasion_id: "fixture",
    recipient_id: "1",
    idea: "Fixture",
    amount: "0.00",
    status: "idea",
  };
  assert.equal(writeGiftSchema.safeParse(input).success, true);
  for (const patch of [
    { recipient_id: undefined },
    { recipient_id: "0" },
    { recipient_id: "9223372036854775808" },
    { amount: "-1" },
    { amount: "NaN" },
    { amount: "1.001" },
    { amount: "10000000000" },
    { status: "unknown" },
    { idea: " " },
    { request_id: "bad" },
    { link: "file:///fixture" },
    { action: "update_gift" },
  ])
    assert.equal(writeGiftSchema.safeParse({ ...input, ...patch }).success, false);
});

test("gift budgets include empty recipients and move commitments to purchases", {
  skip: !process.env.GIFTS_TEST_DATABASE_URL,
}, async () => {
  const db = new pg.Client({ connectionString: process.env.GIFTS_TEST_DATABASE_URL });
  await db.connect();
  const namespace = `gifts_${randomUUID().replaceAll("-", "")}`;
  try {
    await db.query(`create schema ${namespace}`);
    await db.query(`set search_path to ${namespace}`);
    await db.query("create table members (id bigint primary key, first_name text, goes_by text)");
    const migration = await readFile(new URL("../../db/migrations/20261110210000_gifts.sql", import.meta.url), "utf8");
    await db.query(migration.split("-- migrate:down")[0] ?? "");
    await db.query("insert into members values (1, 'Fixture A', null), (2, 'Fixture B', null), (3, 'Fixture C', null)");
    await writeGift(db, {
      action: "occasion",
      request_id: randomUUID(),
      occasion_id: "fixture-one",
      title: "Fixture celebration",
      budget: "100.00",
    });
    await writeGift(db, {
      action: "occasion",
      request_id: randomUUID(),
      occasion_id: "fixture-two",
      title: "Other celebration",
      budget: null,
    });
    for (const occasion_id of ["fixture-one", "fixture-two"]) {
      for (const member_id of ["1", "2", "3"]) {
        await writeGift(db, {
          action: "recipient",
          request_id: randomUUID(),
          occasion_id,
          member_id,
          budget: member_id === "1" ? "40.00" : null,
        });
      }
    }
    const input = {
      action: "add_gift" as const,
      request_id: randomUUID(),
      occasion_id: "fixture-one",
      recipient_id: "1",
      idea: "Sample item",
      amount: "30.00",
      status: "planned" as const,
      buyer_id: "2",
    };
    const first = await writeGift(db, input);
    assert.deepEqual(await writeGift(db, { ...input, amount: "90.00" }), { ...first, already_existed: true });
    for (const [status, amount, buyer_id] of [
      ["idea", "99.00", null],
      ["bought", "20.00", "3"],
      ["wrapped", "5.00", "2"],
      ["given", "2.00", null],
    ] as const) {
      await writeGift(db, { ...input, request_id: randomUUID(), status, amount, buyer_id });
    }
    await writeGift(db, { ...input, request_id: randomUUID(), occasion_id: "fixture-two", amount: "900.00" });
    let report = await readGifts(db, { occasion_id: "fixture-one" });
    assert.ok(report);
    assert.deepEqual(report.totals, { planned: "30.00", bought: "27.00", left: "43.00", over_budget: false });
    assert.equal(report.recipients[0]?.over_budget, true);
    assert.equal(report.recipients[0]?.left, "-17.00");
    assert.deepEqual(
      report.recipients.filter((r) => r.no_gift).map((r) => r.member_id),
      ["2", "3"],
    );
    assert.deepEqual(
      report.buyers.map((b) => [b.buyer_id, b.planned, b.bought]),
      [
        ["2", "30.00", "5.00"],
        ["3", "0.00", "20.00"],
        [null, "0.00", "2.00"],
      ],
    );
    const change = {
      action: "status" as const,
      request_id: randomUUID(),
      gift_id: first.id,
      status: "bought" as const,
    };
    await writeGift(db, change);
    report = await readGifts(db, { occasion_id: "fixture-one" });
    assert.deepEqual(report?.totals, { planned: "0.00", bought: "57.00", left: "43.00", over_budget: false });
    await writeGift(db, { ...change, request_id: randomUUID(), status: "planned" });
    await writeGift(db, change);
    assert.equal((await readGifts(db, { occasion_id: "fixture-one" }))?.totals.planned, "30.00");
    await writeGift(db, {
      ...input,
      action: "update_gift",
      gift_id: first.id,
      request_id: randomUUID(),
      amount: "80.00",
      buyer_id: null,
    });
    assert.equal((await readGifts(db, { occasion_id: "fixture-one" }))?.totals.left, "-7.00");
    assert.equal((await readGifts(db, { occasion_id: "fixture-two" }))?.totals.left, null);
    assert.equal(await readGifts(db, { occasion_id: "missing" }), null);
    await assert.rejects(writeGift(db, { ...change, request_id: randomUUID(), gift_id: randomUUID() }));
    for (const patch of [
      "amount = -1",
      "amount = 'NaN'",
      "status = 'unknown'",
      "recipient_id = null",
      "recipient_id = 999",
      "buyer_id = 999",
    ]) {
      await assert.rejects(db.query(`update gifts set ${patch} where id = $1`, [first.id]));
    }
    for (const table of ["gift_occasions", "gift_recipients"]) {
      for (const budget of ["-1", "NaN", "Infinity"]) {
        await assert.rejects(db.query(`update ${table} set budget = $1`, [budget]));
      }
    }
    const pool = new pg.Pool({ connectionString: process.env.GIFTS_TEST_DATABASE_URL });
    const concurrent = { ...input, request_id: randomUUID() };
    try {
      const run = async () => {
        const client = await pool.connect();
        try {
          await client.query(`set search_path to ${namespace}`);
          return await writeGift(client, concurrent);
        } finally {
          client.release();
        }
      };
      const pair = await Promise.all([run(), run()]);
      assert.equal(pair[0]?.id, pair[1]?.id);
      assert.deepEqual(pair.map((r) => r.already_existed).sort(), [false, true]);
      assert.equal((await readGifts(db, { occasion_id: "fixture-one" }))?.gifts.length, 6);
    } finally {
      await pool.end();
    }
    await assert.rejects(db.query("insert into gift_requests select * from gift_requests limit 1"), { code: "23505" });
    await db.query(migration.split("-- migrate:down")[1] ?? "");
    await db.query(migration.split("-- migrate:down")[0] ?? "");
  } finally {
    await db.query(`drop schema ${namespace} cascade`);
    await db.end();
  }
});
