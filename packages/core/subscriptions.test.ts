import assert from "node:assert/strict";
import test from "node:test";
import { InputError } from "./input-error.ts";
import { buildSubscriptionsCheck, linkSubscriptionMerchantSchema } from "./subscriptions.ts";

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
  for (const id of ["1.0", "abc"])
    assert.equal(
      linkSubscriptionMerchantSchema.safeParse({
        request_id: "00000000-0000-4000-8000-000000000000",
        obligation_id: id,
        merchant: "Test",
        action: "link",
      }).success,
      false,
    );
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

test("on-time charges stay charged every November day through both grace windows", () => {
  for (const day_is_estimate of [false, true]) {
    const plan = { ...obligation, due_day: 15, day_is_estimate };
    const rows = ["2040-09-15", "2040-10-15", "2040-11-15"].map((d) => transaction(d, "9.99"));
    for (let day = 1; day <= 30; day++) {
      const asOf = `2040-11-${String(day).padStart(2, "0")}`;
      const report = buildSubscriptionsCheck([plan], [link], rows, asOf);
      assert.equal(report.subscriptions[0]?.status, "charged_this_cycle", `${asOf} estimated=${day_is_estimate}`);
      assert.deepEqual(report.missing_this_cycle, []);
    }
  }
});

test("early postings remain in their own cycle while status waits for its due date", () => {
  const plan = { ...obligation, due_day: 15 };
  const rows = ["2040-09-13", "2040-10-13"].map((d) => transaction(d, "9.99"));
  const beforeDue = buildSubscriptionsCheck([plan], [link], rows, "2040-11-13").subscriptions[0];
  assert.equal(beforeDue?.status, "charged_this_cycle");
  assert.equal(beforeDue?.cycle_from, "2040-10-10");
  assert.equal(beforeDue?.cycle_through, "2040-11-09");
  for (let day = 15; day <= 44; day++) {
    const asOf = new Date(Date.UTC(2040, 10, day)).toISOString().slice(0, 10);
    assert.equal(
      buildSubscriptionsCheck([plan], [link], rows, asOf).subscriptions[0]?.status,
      "missing_this_cycle",
      asOf,
    );
  }
  assert.equal(
    buildSubscriptionsCheck([plan], [link], [...rows, transaction("2040-11-13", "9.99")], "2040-11-20").subscriptions[0]
      ?.status,
    "charged_this_cycle",
  );
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
    const item = buildSubscriptionsCheck([ob], [link], [transaction(start)], "2040-11-15").subscriptions[0];
    assert.equal(item?.cycle_from, start);
    assert.equal(item?.status, "charged_this_cycle");
    assert.equal(
      buildSubscriptionsCheck([ob], [link], [transaction("2040-11-07")], "2040-11-20").subscriptions[0]?.status,
      "missing_this_cycle",
    );
  }
});

test("scheduled cancellations retain normal status through ended_on and disappear the next day", () => {
  for (const cadence of ["monthly", "yearly"] as const) {
    const plan = { ...obligation, cadence, due_day: 15, due_month: 11, ended_on: "2040-11-20" };
    for (const asOf of ["2040-11-19", "2040-11-20"]) {
      const report = buildSubscriptionsCheck([plan], [link], [transaction("2040-11-15")], asOf);
      assert.equal(report.subscriptions[0]?.status, "charged_this_cycle", `${cadence} ${asOf}`);
      assert.deepEqual(report.charged_after_end, []);
      const unpaid = buildSubscriptionsCheck([plan], [link], [], asOf);
      assert.equal(unpaid.subscriptions[0]?.status, cadence === "monthly" ? "missing_this_cycle" : "yearly_unknown");
    }
    const ended = buildSubscriptionsCheck([plan], [link], [transaction("2040-11-21")], "2040-11-21");
    assert.deepEqual(ended.subscriptions, []);
    assert.equal(ended.charged_after_end[0]?.evidence[0]?.posted_on, "2040-11-21");
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
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
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
  const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  const namespace = `subscriptions_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await db.query(`create schema ${namespace}`);
    await db.query(`set search_path to ${namespace}`);
    for (const name of [
      "20261108230000_obligations_charges_deadlines_loans",
      "20261110150000_accounts_budget_targets",
      "20261110180000_spending_transactions",
      "20261111040000_obligation_merchants",
      "20261111050000_household_transactions",
      "20261111060000_receipt_charges",
    ]) {
      const sql = await readFile(new URL(`../../db/migrations/${name}.sql`, import.meta.url), "utf8");
      await db.query(sql.split("-- migrate:down")[0] ?? "");
    }
    const ids = (
      await db.query(
        "insert into obligations(name,kind,cadence,due_day) values ('Synthetic subscription','subscription','monthly',31),('Synthetic bill','bill','monthly',1) returning id::text",
      )
    ).rows;
    const subscription = ids[0].id;
    const bill = ids[1].id;
    const url = new URL(process.env.TEST_DATABASE_URL ?? "");
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
    await t.test("receipt tool replays and deduplicates evidence without changing spending", async () => {
      const { readSpending } = await import("./spending.ts");
      await db.query(
        "insert into transactions(source,source_id,posted_on,amount,merchant,category,account_ref,pending) values ('fixture','receipt-bank-baseline','2040-04-30',12,'Synthetic wallet','fixture','fixture-card',false)",
      );
      const before = await readSpending(db, { month: "2040-04" }, "2040-05-15");
      const receipt = {
        request_id: crypto.randomUUID(),
        obligation_id: subscription,
        posted_on: "2040-03-31",
        amount: "10.00",
        source_ref: ["synthetic", "receipt.test"].join(String.fromCharCode(64)),
      };
      const unknown = await call("record_receipt_charge", { ...receipt, obligation_id: "9223372036854775807" });
      assert.equal(unknown.isError, true);
      assert.equal(unknown.content[0].text, "Obligation 9223372036854775807 not found.");
      const wrongKind = await call("record_receipt_charge", { ...receipt, obligation_id: bill });
      assert.equal(wrongKind.isError, true);
      assert.equal(wrongKind.content[0].text, `Obligation ${bill} is not a subscription.`);
      const saved = await call("record_receipt_charge", receipt);
      assert.equal(saved.isError, undefined);
      assert.deepEqual(JSON.parse(saved.content[0].text), {
        obligation_id: subscription,
        posted_on: "2040-03-31",
        amount: "10.00",
        source_ref: receipt.source_ref,
      });
      assert.deepEqual(await call("record_receipt_charge", { ...receipt, amount: "99.00" }), saved);
      assert.deepEqual(await call("record_receipt_charge", { ...receipt, request_id: crypto.randomUUID() }), saved);
      const conflict = await call("record_receipt_charge", {
        ...receipt,
        request_id: crypto.randomUUID(),
        amount: "99.00",
      });
      assert.equal(conflict.isError, true);
      assert.equal(conflict.content[0].text, "Receipt source_ref already records a different charge.");
      const second = await call("record_receipt_charge", {
        ...receipt,
        request_id: crypto.randomUUID(),
        posted_on: "2040-04-30",
        amount: "12.00",
        source_ref: "synthetic-second",
      });
      assert.equal(second.isError, undefined);
      const report = await subscriptionsCheck(db, { as_of: "2040-05-15" });
      const item = report.subscriptions[0];
      assert.equal(item?.status, "charged_this_cycle");
      assert.equal(item?.last_charge?.source, "receipt");
      assert.equal(item?.last_charge?.source_id, "synthetic-second");
      assert.equal(item?.previous_amount, "10.00");
      assert.equal(item?.price_changed, true);
      assert.deepEqual(item?.duplicate_charges, []);
      assert.equal(
        (await subscriptionsCheck(db, { as_of: "2040-06-15" })).subscriptions[0]?.status,
        "missing_this_cycle",
      );
      assert.deepEqual(
        await readSpending(db, { month: "2040-04" }, "2040-05-15"),
        before,
        "Receipt evidence never enters spending; bank transactions already record the money movement.",
      );
      const concurrent = await Promise.all([
        call("record_receipt_charge", {
          ...receipt,
          request_id: crypto.randomUUID(),
          source_ref: "synthetic-concurrent",
        }),
        call("record_receipt_charge", {
          ...receipt,
          request_id: crypto.randomUUID(),
          source_ref: "synthetic-concurrent",
        }),
      ]);
      assert.deepEqual(concurrent[0], concurrent[1]);
      assert.equal(concurrent[0].isError, undefined);
      const duplicates = (await subscriptionsCheck(db, { as_of: "2040-05-15" })).subscriptions[0]?.duplicate_charges;
      assert.equal(duplicates?.length, 1);
      assert.equal(duplicates?.[0]?.evidence.length, 2);
      await db.query("delete from receipt_charges");
      await db.query("delete from transactions where source_id = 'receipt-bank-baseline'");
    });
    const command = {
      request_id: crypto.randomUUID(),
      obligation_id: subscription,
      merchant: "Synthetic merchant",
      action: "link" as const,
    };
    const unknown = await call("link_subscription_merchant", { ...command, obligation_id: "9223372036854775807" });
    assert.equal(unknown.isError, true);
    assert.equal(unknown.content[0].text, "Obligation 9223372036854775807 not found.");
    for (const kind of ["loan", "transfer", "card", "investment"]) {
      await t.test(`${kind} merchant links through core and MCP suppress subscription candidates`, async (kindTest) => {
        const recorded = await db.query(
          "insert into obligations(name,kind,cadence,due_day) values ($1,$2,'monthly',1) returning id::text",
          [`Synthetic ${kind}`, kind],
        );
        const obligation_id = recorded.rows[0].id;
        const merchant = `Synthetic ${kind} merchant`;
        await db.query(
          "insert into transactions(source,source_id,posted_on,amount,merchant,category,account_ref,pending) values ('fixture',$1,'2040-03-31',10,$3,'fixture','fixture-card',false),('fixture',$2,'2040-04-30',10,$3,'fixture','fixture-card',false)",
          [`${kind}-first`, `${kind}-second`, merchant],
        );
        const before = await subscriptionsCheck(db, { as_of: "2040-05-15" });
        assert.ok(before.unrecorded_recurring_merchants.some((row) => row.merchant === merchant));
        const input = { ...command, request_id: crypto.randomUUID(), obligation_id, merchant };
        await kindTest.test(`${kind} core link excludes the merchant`, async () => {
          assert.deepEqual(await linkSubscriptionMerchant(db, input), { obligation_id, merchant, linked: true });
          const linked = await subscriptionsCheck(db, { as_of: "2040-05-15" });
          assert.ok(!linked.unrecorded_recurring_merchants.some((row) => row.merchant === merchant));
          assert.deepEqual(
            linked.subscriptions.map((row) => row.obligation_id),
            [subscription],
          );
          assert.deepEqual(linked.charged_after_end, []);
          await linkSubscriptionMerchant(db, { ...input, request_id: crypto.randomUUID(), action: "unlink" });
          const unlinked = await subscriptionsCheck(db, { as_of: "2040-05-15" });
          assert.ok(unlinked.unrecorded_recurring_merchants.some((row) => row.merchant === merchant));
        });
        await kindTest.test(`${kind} MCP link excludes the merchant`, async () => {
          const request = { ...input, request_id: crypto.randomUUID() };
          const saved = await call("link_subscription_merchant", request);
          assert.equal(saved.isError, undefined);
          assert.deepEqual(JSON.parse(saved.content[0].text), { obligation_id, merchant, linked: true });
          assert.deepEqual(await call("link_subscription_merchant", request), saved);
          const read = await call("subscriptions_check", { as_of: "2040-05-15" });
          assert.equal(read.isError, undefined);
          const report = JSON.parse(read.content[0].text);
          assert.ok(
            !report.unrecorded_recurring_merchants.some((row: { merchant: string }) => row.merchant === merchant),
          );
          assert.deepEqual(
            report.subscriptions.map((row: { obligation_id: string }) => row.obligation_id),
            [subscription],
          );
          assert.deepEqual(report.charged_after_end, []);
          await db.query("update obligations set ended_on = '2040-04-01' where id = $1", [obligation_id]);
          const ended = await call("subscriptions_check", { as_of: "2040-05-15" });
          const endedReport = JSON.parse(ended.content[0].text);
          assert.deepEqual(endedReport.charged_after_end, []);
          assert.deepEqual(
            endedReport.subscriptions.map((row: { obligation_id: string }) => row.obligation_id),
            [subscription],
          );
          assert.ok(
            !endedReport.unrecorded_recurring_merchants.some((row: { merchant: string }) => row.merchant === merchant),
          );
        });
      });
    }
    const missingUnlink = { ...command, action: "unlink", request_id: crypto.randomUUID() };
    const missingMessage = `Merchant ${command.merchant} is not linked to obligation ${subscription}; nothing was unlinked.`;
    const missingResult = await call("link_subscription_merchant", missingUnlink);
    assert.equal(missingResult.isError, true);
    assert.equal(missingResult.content[0].text, missingMessage);
    await assert.rejects(linkSubscriptionMerchant(db, missingUnlink), (error) => {
      assert.ok(error instanceof InputError);
      assert.equal(error.message, missingMessage);
      return true;
    });
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

test("business charges cannot become household subscription candidates or linked payment evidence", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const { readFile } = await import("node:fs/promises");
  const { Client } = await import("pg");
  const { importSpending } = await import("./spending.ts");
  const { subscriptionsCheck, linkSubscriptionMerchant } = await import("./subscriptions.ts");
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  const namespace = `household_subscriptions_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await db.query(`create schema ${namespace}`);
    const schema = await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8");
    await db.query(schema.replace(/^\\.*$/gm, "").replaceAll(/\bpublic\b/g, namespace));
    await db.query(`set search_path to ${namespace}`);
    await db.query(`insert into accounts(institution, name, kind, scope, source_ref) values
      ('Synthetic bank', 'Household', 'card', 'household', 'home-card'),
      ('Synthetic bank', 'Business', 'card', 'business', 'work-card'),
      ('Synthetic bank', 'Unknown', 'card', 'unknown', 'unknown-card')`);
    await importSpending(
      db,
      ["home-card", "work-card", "unknown-card", "unmapped-card"].flatMap((account_ref) =>
        ["2040-03-01", "2040-04-01"].map((posted_on) => ({
          source: "synthetic",
          source_id: `${account_ref}-${posted_on}`,
          posted_on,
          amount: "10.00",
          merchant: `Synthetic ${account_ref}`,
          category: "Synthetic category",
          account_ref,
          pending: false,
          exclusion_reason: null,
        })),
      ),
    );
    const check = () => subscriptionsCheck(db, { as_of: "2040-04-15" });
    const result = await check();
    assert.deepEqual(
      result.unrecorded_recurring_merchants.map((row) => row.merchant),
      ["Synthetic home-card", "Synthetic unknown-card", "Synthetic unmapped-card"],
    );
    const { rows } = await db.query(`insert into obligations(name, kind, cadence, due_day)
      values ('Synthetic linked plan', 'subscription', 'monthly', 1) returning id::text`);
    const obligation_id = rows[0].id;
    const saved = await linkSubscriptionMerchant(db, {
      request_id: crypto.randomUUID(),
      obligation_id,
      merchant: "Synthetic work-card",
      action: "link",
    });
    assert.match(saved.warning ?? "", /No matching transaction/);
    const linked = await check();
    assert.equal(linked.subscriptions[0]?.status, "missing_this_cycle");
    assert.equal(linked.subscriptions[0]?.last_charge, null);
    assert.deepEqual(linked.subscriptions[0]?.duplicate_charges, []);
    assert.equal(linked.subscriptions[0]?.price_changed, false);
    await db.query("update obligations set ended_on = '2040-03-15' where id = $1", [obligation_id]);
    assert.deepEqual((await check()).charged_after_end, []);
    await db.query("update accounts set scope = 'household' where source_ref = 'work-card'");
    assert.equal((await check()).charged_after_end[0]?.evidence.length, 1);
  } finally {
    await db.query(`drop schema ${namespace} cascade`);
    await db.end();
  }
});

test("receipt evidence identifies an unlinked plan and a later missing cycle", () => {
  const receipts = [{ obligation_id: "1", posted_on: "2040-04-30", amount: "12.00", source_ref: "synthetic-message" }];
  const report = buildSubscriptionsCheck([obligation], [], [], "2040-05-15", receipts);
  assert.equal(report.subscriptions[0]?.status, "charged_this_cycle");
  assert.equal(report.subscriptions[0]?.last_charge?.source, "receipt");
  assert.equal(
    buildSubscriptionsCheck([obligation], [], [], "2040-06-15", receipts).subscriptions[0]?.status,
    "missing_this_cycle",
  );
});

test("receipt charges share cycle, duplicate and cancellation rules without leaking to another plan", () => {
  const receipt = { obligation_id: "1", posted_on: "2040-04-30", amount: "12.00", source_ref: "synthetic-receipt" };
  const report = buildSubscriptionsCheck(
    [obligation, { ...obligation, id: "2" }],
    [link],
    [transaction("2040-04-30")],
    "2040-05-15",
    [receipt],
  );
  assert.deepEqual(
    report.subscriptions[0]?.duplicate_charges[0]?.evidence.map((row) => row.source),
    ["fixture", "receipt"],
  );
  assert.equal(report.subscriptions[1]?.status, "not_linked");
  const ended = buildSubscriptionsCheck([{ ...obligation, ended_on: "2040-04-29" }], [], [], "2040-05-15", [receipt]);
  assert.equal(ended.charged_after_end[0]?.evidence[0]?.source, "receipt");
  const annual = { ...obligation, cadence: "yearly" as const, due_month: 4 };
  assert.equal(
    buildSubscriptionsCheck([annual], [], [], "2040-05-15", [receipt]).subscriptions[0]?.status,
    "charged_this_cycle",
  );
  assert.equal(
    buildSubscriptionsCheck([annual], [], [], "2041-05-15", [receipt]).subscriptions[0]?.status,
    "missing_this_cycle",
  );
  assert.equal(
    buildSubscriptionsCheck([obligation], [], [], "2040-04-15", [receipt]).subscriptions[0]?.status,
    "not_linked",
  );
});
