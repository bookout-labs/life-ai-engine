import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { documentsCheck, recordDocument } from "./documents.ts";

test("documents check tracks essential household papers through idempotent writes", {
  skip: !process.env.DOCUMENTS_TEST_DATABASE_URL,
}, async (t) => {
  const db = new pg.Client({ connectionString: process.env.DOCUMENTS_TEST_DATABASE_URL });
  await db.connect();
  const namespace = `documents_test_${randomUUID().replaceAll("-", "")}`;
  const migration = await readFile(
    new URL("../../db/migrations/20261110230000_documents.sql", import.meta.url),
    "utf8",
  );
  const [up, down] = migration.split("-- migrate:down");
  assert.ok(up && down);
  try {
    await db.query(`create schema ${namespace}`);
    await db.query(`set search_path to ${namespace}`);
    await db.query(
      "create table members (id bigint primary key, first_name text, goes_by text, born date, species text); create table files (key text primary key)",
    );
    await db.query(up);
    await db.query(`insert into members values
      (1, 'Synthetic adult A', null, '2000-01-01', 'human'), (2, 'Synthetic adult B', null, '2001-01-01', 'human'),
      (3, 'Synthetic minor A', null, '2030-01-01', 'human'), (4, 'Synthetic minor B', null, '2031-01-01', 'human')`);
    const empty = await documentsCheck(db, { as_of: "2040-01-01" });
    assert.equal(empty.requirements.length, 17);
    assert.equal(empty.counts.missing, 17);
    assert.deepEqual(
      empty.requirements.filter((r) => r.kind === "will").map((r) => r.member_id),
      ["1", "2"],
    );
    const command = { request_id: randomUUID(), kind: "will", member_id: "1", location: "Synthetic cabinet" } as const;
    const saved = await recordDocument(db, command);
    assert.equal(saved.already_existed, false);
    const one = await documentsCheck(db, { as_of: "2040-01-01" });
    assert.equal(one.counts.met, 1);
    assert.equal(one.counts.missing, 16);
    assert.equal(one.requirements.at(-1)?.kind, "will");
    assert.deepEqual(await recordDocument(db, { ...command, location: "Changed" }), {
      ...saved,
      already_existed: true,
    });
    await recordDocument(db, { ...command, request_id: randomUUID(), location: null });
    assert.equal((await documentsCheck(db, { as_of: "2040-01-01" })).counts.location_unknown, 1);
    await t.test("birthday, unknown age and species determine requirements", async () => {
      await db.query(
        "insert into members values (5, 'Synthetic unknown', null, null, 'human'), (6, 'Synthetic pet', null, '2000-01-01', 'dog'), (7, 'Synthetic birthday', null, '2022-06-15', 'human')",
      );
      const before = await documentsCheck(db, { as_of: "2040-06-14" });
      const after = await documentsCheck(db, { as_of: "2040-06-15" });
      assert.equal(after.requirements.length - before.requirements.length, 4);
      assert.equal(after.requirements.filter((r) => r.member_id === "7").length, 6);
      assert.equal(before.requirements.filter((r) => r.member_id === "7").length, 2);
      assert.deepEqual(
        after.age_unknown.map((m) => m.id),
        ["5"],
      );
      assert.equal(after.requirements.filter((r) => r.member_id === "5").length, 2);
      assert.equal(
        after.requirements.some((r) => r.member_id === "6"),
        false,
      );
      await db.query("delete from members where id >= 5");
    });
    await t.test("expiration windows and severity ordering", async () => {
      await recordDocument(db, {
        request_id: randomUUID(),
        kind: "passport",
        member_id: "1",
        location: "Synthetic",
        expires_on: "2040-06-28",
      });
      await recordDocument(db, {
        request_id: randomUUID(),
        kind: "passport",
        member_id: "2",
        location: "Synthetic",
        expires_on: "2040-06-30",
      });
      await recordDocument(db, {
        request_id: randomUUID(),
        kind: "healthcare_directive",
        member_id: "1",
        location: "Synthetic",
        expires_on: "2039-12-31",
      });
      await recordDocument(db, {
        request_id: randomUUID(),
        kind: "life_insurance",
        member_id: "1",
        location: null,
        expires_on: "2040-03-01",
      });
      let check = await documentsCheck(db, { as_of: "2040-01-01" });
      assert.deepEqual(
        check.requirements.filter((r) => r.kind === "passport").map((r) => [r.member_id, r.status, r.days]),
        [
          ["1", "expiring", 179],
          ["2", "met", 181],
        ],
      );
      assert.equal(check.counts.expired, 1);
      assert.equal(check.counts.expiring, 2);
      const insurance = check.requirements.find((r) => r.kind === "life_insurance" && r.member_id === "1");
      assert.equal(insurance?.location_unknown, true);
      assert.equal(insurance?.days, 60);
      const statuses = check.requirements.map((r) => r.status);
      assert.ok(statuses.indexOf("expired") < statuses.indexOf("expiring"));
      assert.ok(statuses.lastIndexOf("missing") < statuses.indexOf("expiring"));
      assert.ok(statuses.lastIndexOf("expiring") < statuses.indexOf("location_unknown"));
      assert.ok(statuses.lastIndexOf("location_unknown") < statuses.indexOf("met"));
      check = await documentsCheck(db, { as_of: "2039-12-31" });
      assert.equal(
        check.requirements.find((r) => r.kind === "life_insurance" && r.member_id === "1")?.status,
        "location_unknown",
      );
    });
    await t.test("household guardianship is sufficient and absent without minors", async () => {
      await recordDocument(db, { request_id: randomUUID(), kind: "guardianship", location: "Synthetic" });
      assert.equal(
        (await documentsCheck(db, { as_of: "2040-01-01" })).requirements.find((r) => r.kind === "guardianship")?.status,
        "met",
      );
      assert.equal(
        (await documentsCheck(db, { as_of: "2050-01-01" })).requirements.some((r) => r.kind === "guardianship"),
        false,
      );
    });
    await t.test("retries preserve the original response after later replacement", async () => {
      const replay = await recordDocument(db, command);
      assert.deepEqual(replay, { ...saved, already_existed: true });
      assert.equal(
        (await documentsCheck(db, { as_of: "2040-01-01" })).documents.find((d) => d.id === saved.document.id)?.location,
        null,
      );
      await db.query("insert into files values ('synthetic/scan')");
      const attached = await recordDocument(db, {
        ...command,
        request_id: randomUUID(),
        file_key: "synthetic/scan",
        reviewed_on: "2040-01-01",
        notes: "Synthetic note",
      });
      assert.equal(attached.document.id, saved.document.id);
      assert.equal(attached.document.file_key, "synthetic/scan");
      assert.equal(
        (await documentsCheck(db, { as_of: "2040-01-01" })).documents.find((d) => d.id === saved.document.id)?.notes,
        "Synthetic note",
      );
    });
    await t.test("concurrent retries produce one document", async () => {
      const input = {
        request_id: randomUUID(),
        kind: "birth_certificate",
        member_id: "1",
        location: "Synthetic",
      } as const;
      const write = async () => {
        const connection = new pg.Client({ connectionString: process.env.DOCUMENTS_TEST_DATABASE_URL });
        await connection.connect();
        try {
          await connection.query(`set search_path to ${namespace}`);
          return await recordDocument(connection, input);
        } finally {
          await connection.end();
        }
      };
      const results = await Promise.all([write(), write()]);
      assert.equal(results[0]?.document.id, results[1]?.document.id);
      assert.deepEqual(results.map((r) => r.already_existed).sort(), [false, true]);
    });
    await t.test("recorded papers carry expiry flags even when not required", async () => {
      await recordDocument(db, {
        request_id: randomUUID(),
        kind: "life_insurance",
        member_id: "3",
        location: "Synthetic",
        expires_on: "2039-12-31",
      });
      const check = await documentsCheck(db, { as_of: "2040-01-01" });
      assert.equal(
        check.requirements.some((r) => r.kind === "life_insurance" && r.member_id === "3"),
        false,
      );
      assert.equal(check.documents.find((d) => d.kind === "life_insurance" && d.member_id === "3")?.status, "expired");
    });
    await t.test("constraints and rollback keep invalid rows out", async () => {
      for (const sql of [
        "insert into documents (kind) values ('unknown')",
        "insert into documents (kind, location) values ('will', '   ')",
        "insert into documents (kind, location) values ('will', chr(9))",
        "insert into documents (kind, expires_on) values ('will', 'infinity')",
      ])
        await assert.rejects(db.query(sql), { code: "23514" });
      const bad = { request_id: randomUUID(), kind: "will", member_id: "999", location: "Synthetic" } as const;
      await assert.rejects(recordDocument(db, bad), { code: "23503" });
      assert.equal((await recordDocument(db, { ...bad, member_id: "2" })).already_existed, false);
      await assert.rejects(recordDocument(db, { ...command, request_id: randomUUID(), file_key: "missing" }), {
        code: "23503",
      });
    });
    await db.query(down);
    await db.query(up);
    await db.query(down);
  } finally {
    await db.query(`drop schema ${namespace} cascade`);
    await db.end();
  }
});
