import assert from "node:assert/strict";
import test from "node:test";
import { buildSubscriptionsCheck } from "./subscriptions.ts";

const obligation = {
  id: "1",
  name: "Synthetic plan",
  cadence: "monthly" as const,
  due_day: 31,
  day_is_estimate: false,
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
  assert.equal(item?.cycle_from, "2040-04-25");
  assert.equal(item?.cycle_through, "2040-05-25");
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
        transaction("2040-04-30", "11.01", { merchant: candidate }),
      ],
      "2040-05-15",
    ).unrecorded_recurring_merchants,
    [],
  );
  assert.deepEqual(buildSubscriptionsCheck([], [], rows, "2040-06-15").unrecorded_recurring_merchants, []);
});

test("early postings use five days or seven estimated days with half-open clamped cycles", () => {
  const plan = { ...obligation, due_day: 15 };
  const rows = ["2040-09-13", "2040-10-13", "2040-11-13"].map((d) => transaction(d, "9.99"));
  assert.equal(
    buildSubscriptionsCheck([plan], [link], rows, "2040-11-20").subscriptions[0]?.status,
    "charged_this_cycle",
  );
  for (const [estimated, start] of [
    [false, "2040-11-10"],
    [true, "2040-11-08"],
  ] as const) {
    const ob = { ...plan, day_is_estimate: estimated };
    const item = buildSubscriptionsCheck([ob], [link], [transaction(start)], start).subscriptions[0];
    assert.equal(item?.cycle_from, start);
    assert.equal(item?.status, "charged_this_cycle");
    assert.equal(
      buildSubscriptionsCheck([ob], [link], [transaction("2040-11-07")], "2040-11-20").subscriptions[0]?.status,
      "missing_this_cycle",
    );
  }
});

test("ended plans expose only eligible debits strictly after their end with evidence", () => {
  const ob = { ...obligation, ended_on: "2040-09-30" };
  const rows = [
    transaction("2040-09-30"),
    transaction("2040-10-05", "14.99"),
    transaction("2040-11-05", "14.99"),
    transaction("2040-11-06", "-0.50"),
    transaction("2040-11-07", "14.99", { pending: true }),
    transaction("2040-11-08", "14.99", { exclusion_reason: "hidden" }),
    transaction("2040-12-05"),
  ];
  const report = buildSubscriptionsCheck([ob], [link], rows, "2040-11-20");
  assert.deepEqual(report.subscriptions, []);
  assert.deepEqual(
    report.charged_after_end[0]?.evidence.map((r) => [r.posted_on, r.amount, r.account_ref]),
    [
      ["2040-10-05", "14.99", "fixture-card"],
      ["2040-11-05", "14.99", "fixture-card"],
    ],
  );
  assert.deepEqual(
    buildSubscriptionsCheck([ob], [link], [transaction("2040-09-30")], "2040-11-20").charged_after_end,
    [],
  );
});

test("price compares distinct cycles and duplicate charges keep all dates", () => {
  const rows = [transaction("2040-09-15"), transaction("2040-11-13", "12.50"), transaction("2040-11-14", "12.50")];
  const item = buildSubscriptionsCheck([{ ...obligation, due_day: 15 }], [link], rows, "2040-11-20").subscriptions[0];
  assert.equal(item?.previous_amount, "10.00");
  assert.equal(item?.price_changed, true);
  assert.deepEqual(
    item?.duplicate_charges.map((c) => c.dates),
    [["2040-11-13", "2040-11-14"]],
  );
});

test("candidates collapse duplicates and tolerate adjacent price bumps and skipped months", () => {
  for (const dates of [
    ["2040-08-15", "2040-10-15", "2040-11-15"],
    ["2040-09-15", "2040-10-15", "2040-10-17", "2040-11-15"],
  ]) {
    const rows = dates.map((date) => transaction(date, date === "2040-11-15" ? "10.60" : "10.00"));
    assert.equal(buildSubscriptionsCheck([], [], rows, "2040-11-20").unrecorded_recurring_merchants.length, 1);
  }
  const rows = [transaction("2040-07-15"), transaction("2040-09-15", "11.00"), transaction("2040-11-15", "12.10")];
  assert.equal(buildSubscriptionsCheck([], [], rows, "2041-01-24").unrecorded_recurring_merchants.length, 1);
  assert.equal(buildSubscriptionsCheck([], [], rows, "2041-01-25").unrecorded_recurring_merchants.length, 0);
});

test("candidate gap, duplicate-window and adjacent amount thresholds are inclusive", () => {
  const cases: [string, string[], string[], boolean][] = [
    ["gap25", ["2040-10-21", "2040-11-15"], ["10.00", "10.00"], true],
    ["gap24", ["2040-10-22", "2040-11-15"], ["10.00", "10.00"], false],
    ["gap35", ["2040-10-11", "2040-11-15"], ["10.00", "10.00"], true],
    ["gap36", ["2040-10-10", "2040-11-15"], ["10.00", "10.00"], false],
    ["gap55", ["2040-09-21", "2040-11-15"], ["10.00", "10.00"], true],
    ["gap54", ["2040-09-22", "2040-11-15"], ["10.00", "10.00"], false],
    ["gap70", ["2040-09-06", "2040-11-15"], ["10.00", "10.00"], true],
    ["gap71", ["2040-09-05", "2040-11-15"], ["10.00", "10.00"], false],
    ["duplicate3", ["2040-10-15", "2040-10-18", "2040-11-15"], ["10.00", "10.00", "10.00"], true],
    ["duplicate4", ["2040-10-15", "2040-10-19", "2040-11-15"], ["10.00", "10.00", "10.00"], false],
    ["up10pct", ["2040-10-15", "2040-11-15"], ["10.00", "11.00"], true],
    ["upOver10pct", ["2040-10-15", "2040-11-15"], ["10.00", "11.01"], false],
    ["down10pct", ["2040-10-15", "2040-11-15"], ["10.00", "9.00"], true],
    ["downOver10pct", ["2040-10-15", "2040-11-15"], ["10.00", "8.99"], false],
  ];
  for (const [label, dates, amounts, expected] of cases) {
    const rows = dates.map((date, i) => transaction(date, amounts[i]));
    assert.equal(
      buildSubscriptionsCheck([], [], rows, "2040-11-20").unrecorded_recurring_merchants.length > 0,
      expected,
      label,
    );
  }
});

test("negative fractional credits never become charges or candidates", () => {
  const rows = [transaction("2040-10-15", "-0.50"), transaction("2040-11-15", "-5.50")];
  const report = buildSubscriptionsCheck([obligation], [link], rows, "2040-11-20");
  assert.equal(report.subscriptions[0]?.last_charge, null);
  assert.deepEqual(buildSubscriptionsCheck([], [], rows, "2040-11-20").unrecorded_recurring_merchants, []);
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
    assert.match(JSON.parse(saved.content[0].text).warning, /Synthetic merchant/);
    assert.deepEqual(await call("link_subscription_merchant", command), saved);
    const wrongUnlink = await call("link_subscription_merchant", {
      ...command,
      request_id: crypto.randomUUID(),
      obligation_id: bill,
      action: "unlink",
    });
    assert.equal(wrongUnlink.isError, true);
    assert.equal(wrongUnlink.content[0].text, `Merchant belongs to obligation ${subscription}; nothing was unlinked.`);
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
    const matched = await call("link_subscription_merchant", {
      ...command,
      request_id: crypto.randomUUID(),
      merchant: "Synthetic second",
    });
    assert.equal(JSON.parse(matched.content[0].text).warning, undefined);
    await db.query("update obligations set ended_on = '2040-04-29' where id = $1", [subscription]);
    const endedLink = await call("link_subscription_merchant", {
      ...command,
      request_id: crypto.randomUUID(),
      merchant: "Synthetic second",
    });
    assert.equal(endedLink.isError, undefined);
    const endedRead = await call("subscriptions_check", { as_of: "2040-05-15" });
    assert.equal(JSON.parse(endedRead.content[0].text).charged_after_end[0].evidence[0].amount, "12.00");
    await db.query("update obligations set ended_on = null where id = $1", [subscription]);
    const read = await call("subscriptions_check", { as_of: "2040-05-15" });
    const report = JSON.parse(read.content[0].text);
    assert.equal(report.subscriptions[0].status, "charged_this_cycle");
    assert.equal(report.subscriptions[0].last_charge.amount, "12.00");
    await db.query("update obligations set due_day = 15, day_is_estimate = true where id = $1", [subscription]);
    await db.query(
      "insert into transactions(source,source_id,posted_on,amount,merchant,category,account_ref,pending) values ('fixture','early','2040-11-08',12,'Synthetic second','fixture','fixture-card',false)",
    );
    const estimatedRead = await call("subscriptions_check", { as_of: "2040-11-20" });
    const estimatedItem = JSON.parse(estimatedRead.content[0].text).subscriptions[0];
    assert.equal(estimatedItem.cycle_from, "2040-11-08");
    assert.equal(estimatedItem.status, "charged_this_cycle");
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
