import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { recordContact, recordContactSchema, searchContacts } from "./contacts.ts";

test("contacts round-trip and search by name fragment", {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  for (const id of ["1.0", "abc"])
    assert.equal(
      recordContactSchema.safeParse({
        request_id: "00000000-0000-4000-8000-000000000000",
        name: "Test",
        role: "coach",
        links: [{ kind: "member", id }],
      }).success,
      false,
    );
  const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  const namespace = `contacts_${randomUUID().replaceAll("-", "")}`;
  try {
    await db.query(`create schema ${namespace}`);
    await db.query(`set search_path to ${namespace}`);
    for (const file of [
      "20261108120000_people_activities_events_involvement",
      "20261108180000_members_and_relationships",
      "20261111020000_contacts",
    ]) {
      const sql = await readFile(new URL(`../../db/migrations/${file}.sql`, import.meta.url), "utf8");
      await db.query(sql.split("-- migrate:down")[0] ?? "");
    }
    const saved = await recordContact(db, {
      request_id: randomUUID(),
      name: "Synthetic coach",
      role: "coach",
      links: [],
    });
    assert.equal(saved.contact.name, "Synthetic coach");
    assert.deepEqual(await searchContacts(db, { query: "THETIC COA" }), [saved.contact]);
    const members = (
      await db.query(
        "insert into members(first_name, species) values ('Synthetic A','human'), ('Synthetic B','human'), ('Synthetic pet','dog') returning id::text",
      )
    ).rows;
    const [one, two, pet] = members.map((row) => String(row.id));
    assert.ok(one && two && pet);
    const activity = String(
      (
        await db.query(
          "insert into activities(member_id,activity,season_start) values ($1,'synthetic sport','2040-01-01') returning id::text",
          [one],
        )
      ).rows[0].id,
    );
    const input = {
      request_id: randomUUID(),
      name: "Synthetic teacher",
      role: "teacher",
      organisation: "Synthetic academy",
      links: [
        { kind: "member", id: one },
        { kind: "member", id: two },
        { kind: "activity", id: activity },
      ],
      email: ["synthetic", "example.invalid"].join(String.fromCharCode(64)),
      phone: ["+1", "(202)", "555", "0100"].join(" "),
      address: "Synthetic address",
    };
    await t.test("invisible contact text is rejected before saving", async () => {
      for (const field of ["name", "organisation", "address", "notes"]) {
        for (const value of [...(field === "name" ? ["\u0085"] : []), "\u200b", " \u200b\u0085\t", "\u0301"]) {
          await assert.rejects(
            recordContact(db, { ...input, request_id: randomUUID(), [field]: value }),
            /must contain a visible character/,
          );
        }
      }
      const visible = await recordContact(db, {
        ...input,
        request_id: randomUUID(),
        name: "合成",
        role: "other",
        links: [],
        organisation: "123",
        address: "!",
        notes: "✓",
      });
      assert.equal(visible.contact.name, "合成");
      assert.equal(visible.contact.notes, "✓");
    });
    await t.test("email domains cannot contain empty labels", async () => {
      for (const domain of ["b..c", "b.c."]) {
        await assert.rejects(
          recordContact(db, { ...input, request_id: randomUUID(), email: ["a", domain].join(String.fromCharCode(64)) }),
          /Email must have a dotted domain with no empty labels/,
        );
      }
    });
    await t.test("plain words and underscores both search contact roles", async () => {
      const saved = await recordContact(db, {
        request_id: randomUUID(),
        name: "Synthetic supplier",
        role: "service_provider",
        links: [],
      });
      for (const query of ["service provider", "SERVICE PROVIDER", "service_provider"])
        assert.deepEqual(await searchContacts(db, { query }), [saved.contact]);
    });
    await t.test("empty optional details clear stored values", async () => {
      const saved = await recordContact(db, {
        ...input,
        request_id: randomUUID(),
        name: "Synthetic clearing",
        role: "other",
        links: [],
        notes: "Synthetic note",
      });
      for (const empty of ["", " \t\n", "\u0085", "\u2003"]) {
        const cleared = await recordContact(db, {
          ...input,
          request_id: randomUUID(),
          id: saved.contact.id,
          name: "Synthetic clearing",
          role: "other",
          links: [],
          organisation: empty,
          phone: empty,
          email: empty,
          address: empty,
          notes: empty,
        });
        for (const field of ["organisation", "phone", "email", "address", "notes"] as const)
          assert.equal(cleared.contact[field], null);
        assert.deepEqual(await searchContacts(db, { query: "Synthetic clearing", role: "other" }), [cleared.contact]);
      }
    });
    await t.test("role, organisation, member and activity filters return every link", async () => {
      const result = await recordContact(db, input);
      for (const filter of [
        { role: "teacher" },
        { query: "ACADEMY" },
        { query: "teacher" },
        { member_id: one },
        { member_id: two },
        { activity_id: activity },
      ] satisfies Parameters<typeof searchContacts>[1][])
        assert.deepEqual(await searchContacts(db, filter), [result.contact]);
      assert.deepEqual(await searchContacts(db, { role: "vet" }), []);
      assert.deepEqual(await searchContacts(db, { role: "coach", member_id: one }), []);
    });
    await t.test("updates replace links and old request ids replay the original response", async () => {
      const first = await recordContact(db, input);
      const updated = await recordContact(db, {
        ...input,
        request_id: randomUUID(),
        id: first.contact.id,
        name: "Synthetic revised",
        links: [{ kind: "member", id: two }],
      });
      assert.deepEqual(updated.contact.links, [{ kind: "member", id: two }]);
      assert.deepEqual(await searchContacts(db, { member_id: one }), []);
      assert.deepEqual(await searchContacts(db, { activity_id: activity }), []);
      assert.deepEqual(await searchContacts(db, { member_id: two }), [updated.contact]);
      assert.deepEqual(await recordContact(db, { ...input, name: "Changed retry", links: [] }), {
        ...first,
        already_existed: true,
      });
      assert.deepEqual(await searchContacts(db, { member_id: two }), [updated.contact]);
      await recordContact(db, { ...input, request_id: randomUUID(), id: first.contact.id, links: [] });
      assert.deepEqual(await searchContacts(db, { member_id: two }), []);
    });
    await t.test("missing targets and non-vet pet links give caller-fixable errors and roll back", async () => {
      const request_id = randomUUID();
      for (const [links, message] of [
        [[{ kind: "member", id: "9223372036854775807" }], "Member 9223372036854775807 not found."],
        [[{ kind: "activity", id: "9223372036854775807" }], "Activity 9223372036854775807 not found."],
        [[{ kind: "member", id: pet }], "Only vet contacts can link to non-human members."],
      ] satisfies [unknown[], string][]) {
        await assert.rejects(recordContact(db, { ...input, request_id, links }), { message });
      }
      const vet = await recordContact(db, { ...input, request_id, role: "vet", links: [{ kind: "member", id: pet }] });
      assert.deepEqual(await searchContacts(db, { member_id: pet }), [vet.contact]);
      await assert.rejects(
        recordContact(db, { ...input, request_id: randomUUID(), id: randomUUID() }),
        /Contact .* not found/,
      );
    });
    await t.test("concurrent retries create one contact and preserve the original result", async () => {
      const poolUrl = new URL(process.env.TEST_DATABASE_URL ?? "");
      poolUrl.searchParams.set("options", `-c search_path=${namespace}`);
      const pool = new pg.Pool({ connectionString: poolUrl.toString() });
      try {
        const data = { ...input, request_id: randomUUID(), name: "Synthetic concurrent" };
        const pair = await Promise.all([recordContact(pool, data), recordContact(pool, data)]);
        assert.deepEqual(pair.map((r) => r.already_existed).sort(), [false, true]);
        assert.deepEqual(pair[0]?.contact, pair[1]?.contact);
        assert.equal((await searchContacts(pool, { query: "concurrent" })).length, 1);
      } finally {
        await pool.end();
      }
    });
    await t.test("database constraints reject malformed contact details and links", async () => {
      for (const [name, role, phone, email] of [
        [" ", "coach", null, null],
        ["Synthetic", "unknown", null, null],
        ["Synthetic", "coach", "abc", null],
        ["Synthetic", "coach", "123", null],
        ["Synthetic", "coach", null, "malformed"],
        ["Synthetic", "coach", null, ["bad", "domain"].join(String.fromCharCode(64))],
      ])
        await assert.rejects(
          db.query("insert into contacts(name,role,phone,email) values ($1,$2,$3,$4)", [name, role, phone, email]),
          { code: "23514" },
        );
      await assert.rejects(db.query("insert into contact_links(contact_id) values ($1)", [saved.contact.id]), {
        code: "23514",
      });
      await assert.rejects(
        db.query("insert into contact_links(contact_id,member_id,activity_id) values ($1,$2,$3)", [
          saved.contact.id,
          one,
          activity,
        ]),
        { code: "23514" },
      );
      for (const patch of [
        { name: " " },
        { role: "unknown" },
        { phone: "abc" },
        { email: "malformed" },
        { links: [{ kind: "member", id: "0" }] },
      ])
        await assert.rejects(recordContact(db, { ...input, request_id: randomUUID(), ...patch }));
    });
    await t.test(
      "MCP rejects invisible text and malformed email with specific messages and clears empty details",
      async () => {
        const { registerHooks } = await import("node:module");
        const { createMcpHandler } = await import("@modelcontextprotocol/server");
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
        const url = new URL(process.env.TEST_DATABASE_URL ?? "");
        url.searchParams.set("options", `-c search_path=${namespace}`);
        const handler = createMcpHandler(() => tools({ HYPERDRIVE: { connectionString: url.toString() } } as never));
        const call = async (arguments_: unknown) => {
          const response = await handler.fetch(
            new Request("https://synthetic.test/mcp", {
              method: "POST",
              headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "record_contact", arguments: arguments_ },
              }),
            }),
          );
          const text = await response.text();
          assert.doesNotMatch(text, /Could not save the record/);
          return JSON.parse(text.startsWith("{") ? text : (text.match(/^data: (.*)$/m)?.[1] ?? "")).result;
        };
        const missing = await call({
          ...input,
          request_id: randomUUID(),
          links: [{ kind: "member", id: "9223372036854775807" }],
        });
        assert.equal(missing.isError, true);
        assert.equal(missing.content[0].text, "Member 9223372036854775807 not found.");
        const junk = [
          ...["name", "organisation", "address", "notes"].flatMap((field) =>
            [...(field === "name" ? ["\u0085"] : []), "\u200b"].map((value) => ({
              patch: { [field]: value },
              message: `${field[0]?.toUpperCase()}${field.slice(1)} must contain a visible character (letter, number, punctuation or symbol).`,
            })),
          ),
          ...["b..c", "b.c."].map((domain) => ({
            patch: { email: ["a", domain].join(String.fromCharCode(64)) },
            message: "Email must have a dotted domain with no empty labels.",
          })),
        ];
        for (const { patch, message } of junk) {
          const result = await call({ ...input, request_id: randomUUID(), links: [], ...patch });
          assert.equal(result.isError, true);
          assert.ok(result.content[0].text.includes(message), result.content[0].text);
        }
        const cleared = await call({
          ...input,
          request_id: randomUUID(),
          name: "Synthetic MCP clear",
          links: [],
          organisation: "",
          phone: " \t",
          email: "",
          address: "\u0085",
          notes: "",
        });
        assert.equal(cleared.isError, undefined);
        const contact = JSON.parse(cleared.content[0].text).contact;
        for (const field of ["organisation", "phone", "email", "address", "notes"]) assert.equal(contact[field], null);
      },
    );
    const migration = await readFile(
      new URL("../../db/migrations/20261111020000_contacts.sql", import.meta.url),
      "utf8",
    );
    const [up, down] = migration.split("-- migrate:down");
    assert.ok(up && down);
    await db.query(down);
    assert.equal((await db.query("select to_regclass('contacts') as name")).rows[0].name, null);
    await db.query(up);
    await db.query(down);
  } finally {
    await db.query(`drop schema ${namespace} cascade`);
    await db.end();
  }
});
