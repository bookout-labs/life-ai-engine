import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { activeGoals, recordGoal, recordGoalSchema, setGoalStatus, setGoalStatusSchema } from "./goals.ts";

const input = () => ({
  request_id: randomUUID(),
  area: "practice",
  title: "Complete a sample outcome",
  page_slug: "projects/fixture-plan",
});

test("goal payloads require a complete measure, a real date and a plan slug", () => {
  assert.equal(recordGoalSchema.safeParse(input()).success, true);
  assert.equal(recordGoalSchema.safeParse({ ...input(), measure: { target: "0", unit: "items" } }).success, true);
  for (const patch of [
    { request_id: "invalid" },
    { area: " " },
    { area: "a".repeat(81) },
    { title: "\t" },
    { title: "a".repeat(201) },
    { measure: { target: "1", unit: "a".repeat(41) } },
    { due_on: "1899-12-31" },
    { due_on: "2201-01-01" },
    { page_slug: "invalid slug" },
    { due_on: "2040-02-30" },
    { measure: { target: "2" } },
    { measure: { unit: "items" } },
    { measure: { target: "NaN", unit: "items" } },
    { measure: { target: "Infinity", unit: "items" } },
    { measure: { target: "2", unit: " " } },
  ])
    assert.equal(recordGoalSchema.safeParse({ ...input(), ...patch }).success, false);
  assert.equal(recordGoalSchema.parse({ ...input(), area: "  PRACTICE  " }).area, "practice");
  assert.equal(setGoalStatusSchema.safeParse({ id: "1".repeat(20), status: "done" }).success, false);
  assert.equal(setGoalStatusSchema.safeParse({ id: "1", status: "done" }).success, true);
  assert.equal(setGoalStatusSchema.safeParse({ id: "1", status: "paused" }).success, false);
  assert.equal(setGoalStatusSchema.safeParse({ id: "0", status: "active" }).success, false);
});

test("goals group active records, preserve retries and change status on a disposable database", {
  skip: !process.env.GOALS_TEST_DATABASE_URL,
}, async () => {
  const db = new pg.Pool({ connectionString: process.env.GOALS_TEST_DATABASE_URL });
  const client = await db.connect();
  const namespace = `goals_test_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query(`create schema ${namespace}`);
    await client.query(`set search_path to ${namespace}`);
    for (const name of ["20261109120000_pages_files", "20261110170000_goals"]) {
      const sql = await readFile(new URL(`../../db/migrations/${name}.sql`, import.meta.url), "utf8");
      const [up] = sql.split("-- migrate:down");
      assert.ok(up);
      await client.query(up);
    }
    await client.query(
      "insert into pages (slug, type, title, body) values ('projects/fixture-plan', 'project', 'Fixture', '')",
    );
    assert.deepEqual(await activeGoals(client), []);
    const firstInput = { ...input(), measure: { target: "12.5", unit: "items" }, due_on: "2040-04-01" };
    const first = await recordGoal(client, firstInput);
    assert.equal(first.already_existed, false);
    assert.equal(first.goal.status, "active");
    assert.deepEqual(first.goal.measure, { target: "12.5", unit: "items" });
    assert.equal(first.goal.due_on, "2040-04-01");
    assert.deepEqual(await recordGoal(client, { ...firstInput, title: "Changed retry", measure: null }), {
      goal: first.goal,
      already_existed: true,
    });
    const plain = await recordGoal(client, { ...input(), area: "learning" });
    assert.equal(plain.goal.measure, null);
    assert.equal(plain.goal.due_on, null);
    const extra = await recordGoal(client, input());
    assert.deepEqual(
      (await activeGoals(client)).map((g) => ({ area: g.area, ids: g.goals.map((goal) => goal.id) })),
      [
        { area: "learning", ids: [plain.goal.id] },
        { area: "practice", ids: [first.goal.id, extra.goal.id] },
      ],
    );
    assert.equal((await setGoalStatus(client, { id: first.goal.id, status: "done" }))?.status, "done");
    assert.equal((await setGoalStatus(client, { id: extra.goal.id, status: "dropped" }))?.status, "dropped");
    assert.deepEqual(
      (await activeGoals(client)).map((g) => g.area),
      ["learning"],
    );
    const done = await setGoalStatus(client, { id: plain.goal.id, status: "done" });
    assert.deepEqual(await setGoalStatus(client, { id: plain.goal.id, status: "done" }), done);
    assert.deepEqual(await activeGoals(client), []);
    assert.equal((await recordGoal(client, firstInput)).goal.status, "done");
    assert.equal((await setGoalStatus(client, { id: first.goal.id, status: "active" }))?.status, "active");
    assert.equal(await setGoalStatus(client, { id: "9223372036854775807", status: "done" }), null);
    assert.equal(await setGoalStatus(client, { id: "9223372036854775808", status: "done" }), null);
    await client.query("update pages set deleted_at = now() where slug = $1", [firstInput.page_slug]);
    assert.equal((await activeGoals(client))[0]?.goals[0]?.page_deleted, true);
    await assert.rejects(recordGoal(client, input()), /deleted/i);
    await client.query("update pages set deleted_at = null where slug = $1", [firstInput.page_slug]);

    for (const [column, value] of [
      ["area", " "],
      ["area", " padded"],
      ["area", "a".repeat(81)],
      ["title", "\t"],
      ["title", "padded "],
      ["status", "paused"],
      ["target", "NaN"],
      ["target", "Infinity"],
      ["target", "-Infinity"],
      ["target", "2"],
      ["unit", "items"],
      ["due_on", "infinity"],
      ["request_id", null],
    ]) {
      assert.ok(column);
      const row = { ...input(), [column]: value };
      await assert.rejects(
        client.query(
          `insert into goals (${Object.keys(row).join(", ")})
           values (${Object.keys(row)
             .map((_, i) => `$${i + 1}`)
             .join(", ")})`,
          Object.values(row),
        ),
        { code: column === "request_id" ? "23502" : "23514" },
      );
    }
    await assert.rejects(recordGoal(client, { ...input(), page_slug: "projects/missing" }), { code: "23503" });
    await assert.rejects(client.query("update goals set unit = ' ' where id = $1", [first.goal.id]), { code: "23514" });

    const concurrent = input();
    const write = async () => {
      const connection = await db.connect();
      try {
        await connection.query(`set search_path to ${namespace}`);
        return await recordGoal(connection, concurrent);
      } finally {
        connection.release();
      }
    };
    const pair = await Promise.all([write(), write()]);
    assert.equal(pair[0]?.goal.id, pair[1]?.goal.id);
    assert.deepEqual(pair.map((r) => r.already_existed).sort(), [false, true]);
    assert.equal((await activeGoals(client))[0]?.goals.length, 2);
    await client.query("delete from goals");
    for (const id of [11, 2, 10])
      await client.query(
        "insert into goals(id, request_id, area, title, page_slug) overriding system value values ($1, $2, 'practice', 'Fixture', 'projects/fixture-plan')",
        [id, randomUUID()],
      );
    assert.deepEqual(
      (await activeGoals(client))[0]?.goals.map((goal) => goal.id),
      ["2", "10", "11"],
    );
  } finally {
    await client.query(`drop schema ${namespace} cascade`);
    client.release();
    await db.end();
  }
});
