import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";
import { createMcpHandler } from "@modelcontextprotocol/server";
import pg from "pg";
import { today } from "./schedule.ts";
import { recordWarranty, warrantiesCheck } from "./warranties.ts";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers")
      return {
        url: 'data:text/javascript,export const env = {PUBLIC_ORIGIN: "https://synthetic.test"}; export class WorkerEntrypoint {}',
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const { tools } = await import(new URL("../../apps/mcp/worker.ts", import.meta.url).href);
hooks.deregister();
async function mcp(method: string, params: unknown, dsn?: string) {
  const response = await createMcpHandler(() => tools({ HYPERDRIVE: { connectionString: dsn } } as never)).fetch(
    new Request("https://synthetic.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const text = await response.text();
  return JSON.parse(text.startsWith("{") ? text : (text.match(/^data: (.*)$/m)?.[1] ?? ""));
}

test("warranty MCP tools advertise plain object schemas and read-only check", async () => {
  const payload = await mcp("tools/list", {});
  for (const name of ["record_warranty", "warranties_check"]) {
    const tool = payload.result.tools.find((tool: { name: string }) => tool.name === name);
    assert.ok(tool, name);
    assert.equal(tool.inputSchema.type, "object");
    for (const keyword of ["oneOf", "anyOf", "allOf"]) assert.equal(Object.hasOwn(tool.inputSchema, keyword), false);
    assert.equal(tool.annotations.readOnlyHint, name === "warranties_check");
  }
});

const connectionString = process.env.TEST_DATABASE_URL;
test("warranties record coverage and check its expiry", { skip: !connectionString }, async (t) => {
  const db = new pg.Client({ connectionString });
  await db.connect();
  const namespace = `warranties_test_${randomUUID().replaceAll("-", "")}`;
  const migration = await readFile(
    new URL("../../db/migrations/20261111070000_warranties.sql", import.meta.url),
    "utf8",
  );
  const [up, down] = migration.split("-- migrate:down");
  assert.ok(up && down);
  try {
    await db.query(`create schema ${namespace}`);
    await db.query(`set search_path to ${namespace}`);
    await db.query("create table files (key text primary key)");
    await db.query(up);
    const command = {
      request_id: randomUUID(),
      item: "Synthetic appliance",
      provider: "Synthetic provider",
      kind: "manufacturer",
      purchased_on: "2040-01-01",
      expires_on: "2041-01-01",
      cost_cents: 0,
    } as const;
    const saved = await recordWarranty(db, command);
    assert.equal(saved.already_existed, false);
    assert.equal(saved.warranty.item, "Synthetic appliance");
    assert.equal(saved.warranty.cost_cents, 0);
    assert.equal((await warrantiesCheck(db, { as_of: "2040-01-01" })).active[0]?.id, saved.warranty.id);
    assert.deepEqual(await recordWarranty(db, { ...command, item: "Ignored replay" }), {
      ...saved,
      already_existed: true,
    });
    const replaced = await recordWarranty(db, {
      ...command,
      request_id: randomUUID(),
      id: saved.warranty.id,
      item: "Replacement",
      notes: "Synthetic note",
    });
    assert.equal(replaced.warranty.id, saved.warranty.id);
    assert.equal(replaced.warranty.item, "Replacement");
    assert.deepEqual(await recordWarranty(db, command), { ...saved, already_existed: true });
    assert.equal((await warrantiesCheck(db, { as_of: "2040-01-01" })).active.length, 1);
    assert.equal((await warrantiesCheck(db, { as_of: "2040-01-01" })).active[0]?.notes, "Synthetic note");
    await t.test("source references de-duplicate imports without replacing coverage", async () => {
      const source_ref = ["synthetic-message", "synthetic.test"].join(String.fromCharCode(64));
      const imported = await recordWarranty(db, { ...command, request_id: randomUUID(), source_ref });
      const duplicateCommand = { ...command, request_id: randomUUID(), source_ref, item: "Ignored duplicate" };
      assert.deepEqual(await recordWarranty(db, duplicateCommand), { ...imported, already_existed: true });
      const updated = await recordWarranty(db, {
        ...command,
        request_id: randomUUID(),
        id: imported.warranty.id,
        source_ref,
        item: "Updated imported item",
      });
      assert.equal(updated.warranty.id, imported.warranty.id);
      assert.deepEqual(await recordWarranty(db, duplicateCommand), { ...imported, already_existed: true });
      assert.equal((await warrantiesCheck(db, { as_of: "2040-01-01" })).active.length, 2);
      await assert.rejects(
        recordWarranty(db, { ...command, request_id: randomUUID(), id: saved.warranty.id, source_ref }),
        /Source reference already belongs to another warranty/,
      );
    });
    await t.test("expiry groups include today and day 60, separate unknown from lifetime", async () => {
      for (const [item, expires_on, expiry_unknown] of [
        ["Expired", "2039-12-31", false],
        ["Today", "2040-01-01", false],
        ["Day 59", "2040-02-29", false],
        ["Day 60", "2040-03-01", false],
        ["Day 61", "2040-03-02", false],
        ["Lifetime", null, false],
        ["Unknown", null, true],
      ] as const) {
        await recordWarranty(db, {
          ...command,
          request_id: randomUUID(),
          item,
          purchased_on: "2039-01-01",
          expires_on,
          expiry_unknown,
        });
      }
      const check = await warrantiesCheck(db, { as_of: "2040-01-01" });
      assert.deepEqual(check.counts, { expired: 1, expiring: 3, active: 4, unknown_expiry: 1 });
      assert.deepEqual(
        check.expired.map((w) => w.item),
        ["Expired"],
      );
      assert.deepEqual(
        check.expiring.map((w) => [w.item, w.days]),
        [
          ["Today", 0],
          ["Day 59", 59],
          ["Day 60", 60],
        ],
      );
      assert.ok(check.active.some((w) => w.item === "Day 61" && w.days === 61));
      assert.ok(check.active.some((w) => w.item === "Lifetime" && w.days === null));
      assert.deepEqual(
        check.unknown_expiry.map((w) => w.item),
        ["Unknown"],
      );
      assert.deepEqual(await warrantiesCheck(db, { as_of: "2040-01-01" }), check);
    });
    await t.test("MCP reports actionable domain errors and accepts corrected retries", async () => {
      const dsn = new URL(connectionString ?? "");
      dsn.searchParams.set("options", `-c search_path=${namespace}`);
      const owner = (await warrantiesCheck(db, { as_of: "2040-01-01" })).active.find((w) => w.source_ref !== null);
      assert.ok(owner);
      for (const [patch, message] of [
        [{ purchased_on: "2042-01-01" }, "Warranty expiry cannot precede purchase date."],
        [{ expiry_unknown: true }, "A dated warranty cannot have unknown expiry."],
        [{ id: randomUUID() }, "Warranty not found. Omit id to create a warranty."],
        [
          { id: saved.warranty.id, source_ref: owner.source_ref },
          "Source reference already belongs to another warranty.",
        ],
        [{ file_key: "missing" }, "Warranty file_key must reference an existing file."],
      ] as const) {
        const arguments_ = { ...command, request_id: randomUUID(), ...patch };
        const response = await mcp("tools/call", { name: "record_warranty", arguments: arguments_ }, dsn.href);
        assert.equal(response.result.isError, true);
        assert.equal(response.result.content[0].text, message);
        const corrected = await mcp(
          "tools/call",
          { name: "record_warranty", arguments: { ...command, request_id: arguments_.request_id } },
          dsn.href,
        );
        assert.equal(corrected.result.isError, undefined);
        assert.equal(JSON.parse(corrected.result.content[0].text).already_existed, false);
      }
      for (const patch of [{ item: " " }, { kind: "invalid" }, { cost_cents: -1 }, { expires_on: "2040-02-30" }]) {
        const response = await mcp("tools/call", { name: "record_warranty", arguments: { ...command, ...patch } });
        assert.equal(response.result.isError, true);
        assert.doesNotMatch(response.result.content[0].text, /Could not save the record/);
      }
      const response = await mcp(
        "tools/call",
        { name: "warranties_check", arguments: { as_of: "2040-01-01" } },
        dsn.href,
      );
      assert.deepEqual(JSON.parse(response.result.content[0].text), await warrantiesCheck(db, { as_of: "2040-01-01" }));
      assert.equal((await warrantiesCheck(db)).as_of, today());
    });
    await t.test("replacement clears optional fields and preserves file references", async () => {
      await db.query("insert into files values ('synthetic/warranty-scan')");
      const attached = await recordWarranty(db, {
        ...command,
        request_id: randomUUID(),
        file_key: "synthetic/warranty-scan",
        notes: "Synthetic note",
        source_ref: "synthetic-attachment",
      });
      assert.equal(attached.warranty.file_key, "synthetic/warranty-scan");
      const cleared = await recordWarranty(db, {
        ...command,
        request_id: randomUUID(),
        id: attached.warranty.id,
        expires_on: null,
        cost_cents: undefined,
      });
      assert.equal(cleared.warranty.file_key, null);
      assert.equal(cleared.warranty.notes, null);
      assert.equal(cleared.warranty.source_ref, null);
      assert.equal(cleared.warranty.cost_cents, null);
      assert.equal(cleared.warranty.expiry_unknown, true);
      assert.ok((await warrantiesCheck(db)).unknown_expiry.some((w) => w.id === attached.warranty.id));
    });
    await t.test("concurrent request retries and source imports each create one warranty", async () => {
      for (const sharedRequest of [true, false]) {
        const request_id = randomUUID();
        const source_ref = `synthetic-concurrent-${randomUUID()}`;
        const write = async () => {
          const connection = new pg.Client({ connectionString });
          await connection.connect();
          try {
            await connection.query(`set search_path to ${namespace}`);
            return await recordWarranty(connection, {
              ...command,
              request_id: sharedRequest ? request_id : randomUUID(),
              source_ref,
            });
          } finally {
            await connection.end();
          }
        };
        const results = await Promise.all([write(), write()]);
        assert.equal(results[0]?.warranty.id, results[1]?.warranty.id);
        assert.deepEqual(results.map((r) => r.already_existed).sort(), [false, true]);
        const check = await warrantiesCheck(db);
        const all = [...check.expired, ...check.expiring, ...check.active, ...check.unknown_expiry];
        assert.equal(all.filter((w) => w.source_ref === source_ref).length, 1);
      }
    });
    await t.test("check runs in a read-only transaction", async () => {
      await db.query("begin read only");
      try {
        await warrantiesCheck(db, { as_of: "2040-01-01" });
      } finally {
        await db.query("rollback");
      }
    });
    await db.query(down);
    await db.query(up);
    await db.query(down);
  } finally {
    await db.query(`drop schema ${namespace} cascade`);
    await db.end();
  }
});
