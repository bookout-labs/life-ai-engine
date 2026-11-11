import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { ZodError } from "zod";
import { readGifts, recordGiftInputSchema, writeGift, writeGiftSchema } from "./gifts.ts";
import { readToday } from "./today.ts";
import { weekly } from "./weekly.ts";

test("flat gift input preserves all five commands and their required fields", () => {
  const base = { request_id: randomUUID(), occasion_id: "fixture" };
  const gift = { ...base, recipient_id: randomUUID(), idea: "Fixture", amount: "0.00", status: "idea" };
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
    recipient_id: randomUUID(),
    idea: "Fixture",
    amount: "0.00",
    status: "idea",
  };
  assert.equal(writeGiftSchema.safeParse(input).success, true);
  for (const patch of [
    { member_id: "1.0", action: "recipient", budget: null },
    { member_id: "abc", action: "recipient", budget: null },
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

test("recipients use exactly one identity and only ideas may have no price", () => {
  const base = { action: "recipient", request_id: randomUUID(), occasion_id: "fixture", budget: null };
  assert.equal(writeGiftSchema.safeParse({ ...base, name: "Fixture coach" }).success, true);
  assert.equal(writeGiftSchema.safeParse({ ...base, member_id: "1" }).success, true);
  for (const identity of [{}, { name: "Fixture coach", member_id: "1" }, { name: " " }]) {
    assert.equal(writeGiftSchema.safeParse({ ...base, ...identity }).success, false);
  }
  const gift = {
    action: "add_gift",
    request_id: randomUUID(),
    occasion_id: "fixture",
    recipient_id: randomUUID(),
    idea: "Fixture",
    amount: null,
  };
  assert.equal(writeGiftSchema.safeParse({ ...gift, status: "idea" }).success, true);
  for (const status of ["planned", "bought", "wrapped", "given"]) {
    assert.equal(writeGiftSchema.safeParse({ ...gift, status }).success, false);
  }
});

test("gift budgets include empty recipients and move commitments to purchases", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  const namespace = `gifts_${randomUUID().replaceAll("-", "")}`;
  try {
    await db.query(`create schema ${namespace}`);
    await db.query(`set search_path to ${namespace}`);
    const dir = new URL("../../db/migrations/", import.meta.url);
    for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
      const [up] = (await readFile(new URL(file, dir), "utf8")).split("-- migrate:down");
      await db.query(up ?? "");
    }
    await db.query(
      "insert into members (id, first_name) overriding system value values (1, 'Fixture A'), (2, 'Fixture B'), (3, 'Fixture C')",
    );
    const recipients = new Map<string, string>();
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
        const recipient = await writeGift(db, {
          action: "recipient",
          request_id: randomUUID(),
          occasion_id,
          member_id,
          budget: member_id === "1" ? "40.00" : null,
        });
        assert.ok(recipient);
        recipients.set(`${occasion_id}/${member_id}`, recipient.id);
      }
    }
    const reportBefore = await readGifts(db, { occasion_id: "fixture-one" });
    const recipientId = reportBefore?.recipients.find((r) => r.member_id === "1")?.id;
    const otherId = recipients.get("fixture-two/1");
    assert.ok(recipientId && otherId);
    const input = {
      action: "add_gift" as const,
      request_id: randomUUID(),
      occasion_id: "fixture-one",
      recipient_id: recipientId,
      idea: "Sample item",
      amount: "30.00",
      status: "planned" as const,
      buyer_id: "2",
    };
    const first = await writeGift(db, input);
    assert.ok(first);
    assert.deepEqual(await writeGift(db, { ...input, amount: "90.00" }), { ...first, already_existed: true });
    for (const [status, amount, buyer_id] of [
      ["idea", "99.00", null],
      ["bought", "20.00", "3"],
      ["wrapped", "5.00", "2"],
      ["given", "2.00", null],
    ] as const) {
      await writeGift(db, { ...input, request_id: randomUUID(), status, amount, buyer_id });
    }
    await writeGift(db, {
      ...input,
      request_id: randomUUID(),
      occasion_id: "fixture-two",
      recipient_id: otherId,
      amount: "900.00",
    });
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
    for (const action of ["status", "update_gift"] as const) {
      assert.equal(
        await writeGift(db, { ...input, ...change, action, request_id: randomUUID(), gift_id: randomUUID() }),
        null,
      );
    }
    for (const patch of [
      "amount = -1",
      "amount = 'NaN'",
      "status = 'unknown'",
      "recipient_id = null",
      "recipient_id = gen_random_uuid()",
      "buyer_id = 999",
    ]) {
      await assert.rejects(db.query(`update gifts set ${patch} where id = $1`, [first.id]));
    }
    for (const table of ["gift_occasions", "gift_recipients"]) {
      for (const budget of ["-1", "NaN", "Infinity"]) {
        await assert.rejects(db.query(`update ${table} set budget = $1`, [budget]));
      }
    }
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
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
      assert.deepEqual(
        pair
          .map((r) => {
            assert.ok(r);
            return r.already_existed;
          })
          .sort(),
        [false, true],
      );
      assert.equal((await readGifts(db, { occasion_id: "fixture-one" }))?.gifts.length, 6);
    } finally {
      await pool.end();
    }
    const todayBefore = (await readToday(db, "2040-01-01T12:00:00Z")).members;
    const weeklyBefore = (await weekly(db, "2040-01-01")).members;
    const coachCommand = {
      action: "recipient" as const,
      request_id: randomUUID(),
      occasion_id: "fixture-one",
      name: "Fixture coach",
      budget: "15.00",
    };
    const coach = await writeGift(db, coachCommand);
    assert.ok(coach);
    assert.deepEqual(await writeGift(db, coachCommand), { ...coach, already_existed: true });
    const coachAgain = await writeGift(db, { ...coachCommand, request_id: randomUUID() });
    assert.equal(coachAgain?.id, coach.id);
    const beforeIdea = await readGifts(db, { occasion_id: "fixture-one" });
    const idea = await writeGift(db, {
      ...input,
      request_id: randomUUID(),
      recipient_id: coach.id,
      status: "idea",
      amount: null,
    });
    assert.ok(idea);
    const ideasOnly = await readGifts(db, { occasion_id: "fixture-one" });
    assert.deepEqual(ideasOnly?.totals, beforeIdea?.totals);
    assert.equal(ideasOnly?.gifts.find((g) => g.id === idea.id)?.amount, null);
    assert.deepEqual(
      ideasOnly?.recipients.find((r) => r.id === coach.id),
      {
        id: coach.id,
        member_id: null,
        name: "Fixture coach",
        budget: "15.00",
        planned: "0.00",
        bought: "0.00",
        left: "15.00",
        over_budget: false,
        no_gift: true,
      },
    );
    const promotion = {
      action: "status" as const,
      request_id: randomUUID(),
      gift_id: idea.id,
      status: "planned" as const,
    };
    await assert.rejects(writeGift(db, promotion), { code: "23514" });
    for (const status of ["planned", "bought"] as const) {
      await assert.rejects(
        writeGift(db, { ...input, request_id: randomUUID(), recipient_id: coach.id, status, amount: null }),
        ZodError,
      );
    }
    await writeGift(db, {
      ...input,
      action: "update_gift",
      gift_id: idea.id,
      request_id: randomUUID(),
      recipient_id: coach.id,
      amount: "10.00",
      status: "planned",
    });
    let coachReport = (await readGifts(db, { occasion_id: "fixture-one" }))?.recipients.find((r) => r.id === coach.id);
    assert.equal(coachReport?.planned, "10.00");
    assert.equal(coachReport?.no_gift, false);
    await writeGift(db, { ...promotion, status: "bought" });
    coachReport = (await readGifts(db, { occasion_id: "fixture-one" }))?.recipients.find((r) => r.id === coach.id);
    assert.equal(coachReport?.bought, "10.00");
    assert.equal(coachReport?.left, "5.00");
    assert.deepEqual((await readToday(db, "2040-01-01T12:00:00Z")).members, todayBefore);
    assert.deepEqual((await weekly(db, "2040-01-01")).members, weeklyBefore);
    await assert.rejects(db.query("update gift_recipients set member_id = 1 where id = $1", [coach.id]), {
      code: "23514",
    });
    await assert.rejects(db.query("update gift_recipients set name = null where id = $1", [coach.id]), {
      code: "23514",
    });
    await assert.rejects(db.query("update gifts set occasion_id = 'fixture-two' where id = $1", [idea.id]), {
      code: "23503",
    });
    await assert.rejects(db.query("insert into gift_requests select * from gift_requests limit 1"), { code: "23505" });
  } finally {
    await db.query(`drop schema ${namespace} cascade`);
    await db.end();
  }
});

test("recipient migration reverses on empty tables and refuses populated gift tables", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  const namespace = `gift_migration_${randomUUID().replaceAll("-", "")}`;
  const original = await readFile(new URL("../../db/migrations/20261110210000_gifts.sql", import.meta.url), "utf8");
  const migration = await readFile(
    new URL("../../db/migrations/20261110220000_gift_recipient_identity.sql", import.meta.url),
    "utf8",
  );
  const [up, down] = migration.split("-- migrate:down");
  assert.ok(up && down);
  const run = async (sql: string) => {
    await db.query("begin");
    try {
      await db.query(sql);
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  };
  try {
    await db.query(`create schema ${namespace}`);
    await db.query(`set search_path to ${namespace}`);
    await db.query("create table members (id bigint primary key)");
    await db.query(original.split("-- migrate:down")[0] ?? "");
    await run(up);
    await run(down);
    await run(up);
    await run(down);
    await db.query("insert into members values (1)");
    await db.query("insert into gift_occasions (id, title) values ('fixture', 'Fixture')");
    await db.query("insert into gift_recipients (occasion_id, member_id) values ('fixture', 1)");
    await db.query(
      "insert into gifts (occasion_id, recipient_id, idea, amount, status) values ('fixture', 1, 'Fixture', 1, 'planned')",
    );
    await assert.rejects(run(up), /must all be empty/);
    assert.equal((await db.query("select count(*)::int as count from gifts")).rows[0].count, 1);
    await db.query("truncate gifts, gift_recipients, gift_occasions, gift_requests");
    await db.query("insert into gift_requests values ($1, '{}')", [randomUUID()]);
    await assert.rejects(run(up), /must all be empty/);
    await db.query("truncate gift_requests");
    await run(up);
    await db.query("insert into gift_occasions (id, title) values ('fixture', 'Fixture')");
    await assert.rejects(run(down), /must all be empty/);
  } finally {
    await db.query(`drop schema ${namespace} cascade`);
    await db.end();
  }
});
