import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { weekly } from "./weekly.ts";

test("weekly lists use numeric member, relationship and activity order", {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  const namespace = `weekly_${randomUUID().replaceAll("-", "")}`;
  try {
    await db.query(`create schema ${namespace}`);
    await db.query(`set search_path to ${namespace}`);
    const root = new URL("../../db/migrations/", import.meta.url);
    for (const file of (await readdir(root)).filter((name) => name.endsWith(".sql")).sort())
      await db.query((await readFile(new URL(file, root), "utf8")).split("-- migrate:down")[0] ?? "");
    await db.query(`
      insert into members(id, first_name) overriding system value values (11, 'Fixture C'), (2, 'Fixture A'), (10, 'Fixture B');
      insert into relationships(member_id, related_id, kind) values
        (11, 10, 'parent'), (11, 2, 'parent'), (10, 2, 'parent'), (2, 11, 'parent'), (2, 10, 'parent');
      insert into activities(id, member_id, activity, season_start) overriding system value values
        (11, 2, 'fixture c', '2040-01-01'), (2, 2, 'fixture a', '2040-01-01'),
        (10, 2, 'fixture b', '2040-01-01'), (12, 10, 'fixture d', '2040-01-01'), (13, 11, 'fixture e', '2040-01-01');
    `);
    await t.test("members", async () => {
      assert.deepEqual(
        (await weekly(db, "2040-01-01")).members.map((m) => m.id),
        ["2", "10", "11"],
      );
    });
    await t.test("relationships use both numeric keys", async () => {
      assert.deepEqual(
        (await weekly(db, "2040-01-01")).relationships.map((r) => [r.member_id, r.related_id]),
        [
          ["2", "10"],
          ["2", "11"],
          ["10", "2"],
          ["11", "2"],
          ["11", "10"],
        ],
      );
    });
    await t.test("activities use numeric member and activity ids", async () => {
      assert.deepEqual(
        (await weekly(db, "2040-01-01")).activities.map((a) => a.id),
        ["2", "10", "11", "12", "13"],
      );
    });
  } finally {
    await db.query(`drop schema ${namespace} cascade`);
    await db.end();
  }
});
