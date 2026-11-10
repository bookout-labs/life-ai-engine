import assert from "node:assert/strict";
import test from "node:test";
import { buildSubscriptionsCheck } from "./subscriptions.ts";

const obligation = {
  id: "1",
  name: "Synthetic plan",
  cadence: "monthly" as const,
  due_day: 31,
  due_month: null,
  pays_from: null,
  ended_on: null,
};
const link = { obligation_id: "1", merchant: "Synthetic merchant" };
const transaction = (posted_on: string, amount = "10.00", extra = {}) => ({
  source: "fixture",
  source_id: posted_on,
  posted_on,
  amount,
  merchant: link.merchant,
  account_ref: "fixture-card",
  pending: false,
  exclusion_reason: null,
  ...extra,
});

test("monthly cycle clamps due 31 to April 30 and shows actual price and payer", () => {
  const report = buildSubscriptionsCheck(
    [obligation],
    [link],
    [transaction("2040-03-31"), transaction("2040-04-30", "12.00")],
    "2040-05-15",
  );
  const item = report.subscriptions[0];
  assert.equal(item?.status, "charged_this_cycle");
  assert.equal(item?.cycle_from, "2040-04-30");
  assert.equal(item?.cycle_through, "2040-05-30");
  assert.equal(item?.last_charge?.account_ref, "fixture-card");
  assert.equal(item?.last_charge?.amount, "12.00");
  assert.equal(item?.previous_amount, "10.00");
  assert.equal(item?.price_changed, true);
  assert.equal(
    buildSubscriptionsCheck([obligation], [link], [transaction("2040-03-31")], "2040-05-15").subscriptions[0]?.status,
    "missing_this_cycle",
  );
});

test("credits, exclusions, pending and future debits do not conceal a missing charge", () => {
  const rows = [
    transaction("2040-03-31"),
    transaction("2040-04-30", "-10.00"),
    transaction("2040-05-01", "10.00", { pending: true }),
    transaction("2040-05-02", "10.00", { exclusion_reason: "hidden" }),
    transaction("2040-05-31"),
  ];
  const report = buildSubscriptionsCheck([obligation], [link], rows, "2040-05-15");
  assert.equal(report.subscriptions[0]?.status, "missing_this_cycle");
  assert.equal(report.subscriptions[0]?.last_charge?.posted_on, "2040-03-31");
  assert.equal(report.missing_this_cycle.length, 1);
});

test("unlinked, ended, yearly unknown and yearly observed subscriptions are distinct", () => {
  assert.equal(buildSubscriptionsCheck([obligation], [], [], "2040-05-15").subscriptions[0]?.status, "not_linked");
  assert.deepEqual(
    buildSubscriptionsCheck([{ ...obligation, ended_on: "2040-01-01" }], [link], [], "2040-05-15").subscriptions,
    [],
  );
  const annual = { ...obligation, cadence: "yearly" as const, due_month: 4 };
  assert.equal(buildSubscriptionsCheck([annual], [link], [], "2040-05-15").subscriptions[0]?.status, "yearly_unknown");
  assert.equal(
    buildSubscriptionsCheck([annual], [link], [transaction("2040-04-30")], "2040-05-15").subscriptions[0]?.status,
    "charged_this_cycle",
  );
});

test("monthly candidates expose evidence and exclude linked merchants and weekly shopping", () => {
  const candidate = "Synthetic candidate";
  const rows = [
    transaction("2040-03-31", "10.00", { merchant: candidate }),
    transaction("2040-04-30", "10.50", { merchant: candidate, account_ref: "fixture-other" }),
  ];
  const report = buildSubscriptionsCheck([], [], rows, "2040-05-15");
  assert.equal(report.unrecorded_recurring_merchants.length, 1);
  assert.deepEqual(
    report.unrecorded_recurring_merchants[0]?.evidence.map((row) => [row.posted_on, row.amount, row.account_ref]),
    [
      ["2040-03-31", "10.00", "fixture-card"],
      ["2040-04-30", "10.50", "fixture-other"],
    ],
  );
  assert.deepEqual(
    buildSubscriptionsCheck([], [{ obligation_id: "2", merchant: candidate }], rows, "2040-05-15")
      .unrecorded_recurring_merchants,
    [],
  );
  const groceries = [
    transaction("2040-04-01", "18.00"),
    transaction("2040-04-08", "37.00"),
    transaction("2040-04-15", "21.00"),
    transaction("2040-05-01", "18.00"),
  ];
  assert.deepEqual(buildSubscriptionsCheck([], [], groceries, "2040-05-15").unrecorded_recurring_merchants, []);
  assert.deepEqual(
    buildSubscriptionsCheck(
      [],
      [],
      [
        transaction("2040-03-31", "10.00", { merchant: candidate }),
        transaction("2040-04-30", "10.51", { merchant: candidate }),
      ],
      "2040-05-15",
    ).unrecorded_recurring_merchants,
    [],
  );
  assert.deepEqual(buildSubscriptionsCheck([], [], rows, "2040-06-15").unrecorded_recurring_merchants, []);
});

test("subscription tools save replayable links and return specific MCP input errors", {
  skip: !process.env.SUBSCRIPTIONS_TEST_DATABASE_URL,
}, async () => {
  const { readFile } = await import("node:fs/promises");
  const { registerHooks } = await import("node:module");
  const { createMcpHandler } = await import("@modelcontextprotocol/server");
  const { default: pg } = await import("pg");
  const { linkSubscriptionMerchant, subscriptionsCheck } = await import("./subscriptions.ts");
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
  const db = new pg.Client({ connectionString: process.env.SUBSCRIPTIONS_TEST_DATABASE_URL });
  await db.connect();
  const namespace = `subscriptions_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await db.query(`create schema ${namespace}`);
    await db.query(`set search_path to ${namespace}`);
    for (const name of [
      "20261108230000_obligations_charges_deadlines_loans",
      "20261110180000_spending_transactions",
      "20261111040000_obligation_merchants",
    ]) {
      const sql = await readFile(new URL(`../../db/migrations/${name}.sql`, import.meta.url), "utf8");
      await db.query(sql.split("-- migrate:down")[0] ?? "");
    }
    const ids = (
      await db.query(
        "insert into obligations(name,kind,cadence,due_day) values ('Synthetic subscription','subscription','monthly',31),('Synthetic bill','bill','monthly',1),('Synthetic transfer','transfer','monthly',1) returning id::text",
      )
    ).rows;
    const subscription = ids[0].id;
    const bill = ids[1].id;
    const transfer = ids[2].id;
    const url = new URL(process.env.SUBSCRIPTIONS_TEST_DATABASE_URL ?? "");
    url.searchParams.set("options", `-c search_path=${namespace}`);
    const call = async (name: string, args: unknown) => {
      const response = await createMcpHandler(() =>
        tools({ HYPERDRIVE: { connectionString: url.toString() } } as never),
      ).fetch(
        new Request("https://synthetic.test/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
        }),
      );
      const text = await response.text();
      return JSON.parse(text.startsWith("{") ? text : (text.match(/^data: (.*)$/m)?.[1] ?? "")).result;
    };
    const command = {
      request_id: crypto.randomUUID(),
      obligation_id: subscription,
      merchant: "Synthetic merchant",
      action: "link" as const,
    };
    for (const [obligation_id, expected] of [
      ["9223372036854775807", "Obligation 9223372036854775807 not found."],
      [transfer, "Only subscription or bill obligations can link merchants."],
    ]) {
      const result = await call("link_subscription_merchant", { ...command, obligation_id });
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, expected);
    }
    const saved = await call("link_subscription_merchant", command);
    assert.equal(saved.isError, undefined);
    const result = await call("link_subscription_merchant", {
      ...command,
      request_id: crypto.randomUUID(),
      obligation_id: bill,
    });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "Merchant is already linked to another obligation. Unlink it there first.");
    await linkSubscriptionMerchant(db, { ...command, request_id: crypto.randomUUID(), action: "unlink" });
    const replay = await call("link_subscription_merchant", { ...command, action: "unlink" });
    assert.deepEqual(replay, saved);
    assert.equal((await subscriptionsCheck(db, { as_of: "2040-05-15" })).subscriptions[0]?.status, "not_linked");
    await linkSubscriptionMerchant(db, { ...command, request_id: crypto.randomUUID(), obligation_id: bill });
    await linkSubscriptionMerchant(db, { ...command, request_id: crypto.randomUUID(), merchant: "Synthetic second" });
    await db.query(
      "insert into transactions(source,source_id,posted_on,amount,merchant,category,account_ref,pending) values ('fixture','one','2040-04-30',12,'Synthetic second','fixture','fixture-card',false)",
    );
    const read = await call("subscriptions_check", { as_of: "2040-05-15" });
    const report = JSON.parse(read.content[0].text);
    assert.equal(report.subscriptions[0].status, "charged_this_cycle");
    assert.equal(report.subscriptions[0].last_charge.amount, "12.00");
    const migration = await readFile(
      new URL("../../db/migrations/20261111040000_obligation_merchants.sql", import.meta.url),
      "utf8",
    );
    await db.query(migration.split("-- migrate:down")[1] ?? "");
    await db.query(migration.split("-- migrate:down")[0] ?? "");
    assert.equal((await subscriptionsCheck(db, { as_of: "2040-05-15" })).subscriptions[0]?.status, "not_linked");
  } finally {
    await db.query(`drop schema ${namespace} cascade`);
    await db.end();
  }
});
