import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { buildSpending } from "./spending.ts";
import { fromConnector, importTransactionsSchema } from "./spending-import.ts";

const transaction = {
  id: "123",
  date: "2040-02-01",
  pending: false,
  merchant: "Synthetic merchant",
  merchant_id: "456",
  amount: -157.57,
  formatted_amount: "-$157.57",
  category: "Food",
  category_id: "789",
  account: "Synthetic account 0000",
  account_id: "321",
};

test("connector expenses and refunds become exact decimal strings and account references use IDs", () => {
  const [row, refund, dime, fifth] = fromConnector(
    [transaction, { ...transaction, amount: 9.99 }, { ...transaction, amount: -0.1 }, { ...transaction, amount: -0.2 }],
    { source: "monarch" },
  );
  assert.deepEqual(row, {
    source: "monarch",
    source_id: "123",
    posted_on: "2040-02-01",
    pending: false,
    merchant: "Synthetic merchant",
    amount: "157.57",
    category: "Food",
    account_ref: "321",
    exclusion_reason: null,
  });
  assert.equal(refund?.amount, "-9.99");
  assert.equal(dime?.amount, "0.10");
  assert.equal(fifth?.amount, "0.20");
});

test("connector rejects fractional cents, drift, nonfinite numbers and malformed pages", () => {
  for (const amount of [1.001, 0.1 + 0.2, Infinity, -Infinity, NaN]) {
    assert.throws(() => fromConnector([{ ...transaction, amount }], { source: "monarch" }));
  }
  assert.throws(() => fromConnector([{ ...transaction, date: "invalid" }], { source: "monarch" }));
  assert.throws(() => fromConnector(Array(101).fill(transaction), { source: "monarch" }));
});

test("connector defaults, custom exclusions and hidden batches preserve spending policy", () => {
  const rows = ["Transfer", "Credit Card Payment", "Paychecks", "Interest", "Renamed", "Food", "toString"].map(
    (category) => ({ ...transaction, category }),
  );
  assert.deepEqual(
    fromConnector(rows, { source: "monarch", exclude: { Renamed: "transfer", Interest: "transfer" } }).map(
      (row) => row.exclusion_reason,
    ),
    ["transfer", "transfer", "income", "transfer", "transfer", null, null],
  );
  assert.ok(fromConnector(rows, { source: "monarch", hidden: true }).every((row) => row.exclusion_reason === "hidden"));
});

test("all default income and transfer categories stay out of net spending", () => {
  const rows = [
    ["Other Income", 5000],
    ["Business Income", 300],
    ["Balance Adjustments", 40],
    ["Food", -50],
    ["Food", 10],
  ].map(([category, amount], index) => ({ ...transaction, id: String(index), category, amount }));
  const imported = fromConnector(rows, { source: "monarch" });
  assert.deepEqual(
    imported.map((row) => row.exclusion_reason),
    ["income", "income", "transfer", null, null],
  );
  assert.equal(buildSpending(imported, [], { month: "2040-02" }, "2040-02-28").total, "40.00");
});

test("exclusion categories and custom keys ignore surrounding whitespace and case", () => {
  const rows = [
    " transfer ",
    "credit card payment",
    " BUSINESS INCOME ",
    " other income",
    "balance adjustments",
    " PAYCHECKS ",
    " interest ",
    "renamed",
    "Food",
  ].map((category) => ({ ...transaction, category }));
  assert.deepEqual(
    fromConnector(rows, { source: "monarch", exclude: { " ReNaMeD ": "hidden", " INTEREST ": "transfer" } }).map(
      (row) => row.exclusion_reason,
    ),
    ["transfer", "transfer", "income", "income", "transfer", "income", "transfer", "hidden", null],
  );
});

test("connector accepts only the literal monarch source so spelling cannot duplicate imports", () => {
  for (const source of ["Monarch", " monarch ", "synthetic", ""]) {
    assert.equal(importTransactionsSchema.safeParse({ source, transactions: [transaction] }).success, false);
  }
  assert.equal(fromConnector([transaction], { source: "monarch" })[0]?.source, "monarch");
});

test("import tool advertises destructive idempotent writes and the monarch source", async () => {
  const worker = await readFile(new URL("../../apps/mcp/worker.ts", import.meta.url), "utf8");
  const registration = worker.match(
    /server\.registerTool\(\s*"import_transactions",[\s\S]*?(?=server\.registerTool)/,
  )?.[0];
  assert.ok(registration);
  const server = new McpServer({ name: "spending-test", version: "1.0.0" });
  runInNewContext(registration, { server, importTransactionsSchema });
  const response = await createMcpHandler(() => server).fetch(
    new Request("https://synthetic.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
  );
  assert.equal(response.status, 200);
  const result = await response.text();
  const payload = JSON.parse(result.startsWith("event:") ? (result.match(/^data: (.*)$/m)?.[1] ?? "") : result);
  const tool = payload.result.tools.find((entry: { name: string }) => entry.name === "import_transactions");
  assert.ok(tool);
  assert.deepEqual(tool.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  });
  assert.match(tool.description, /source.*"monarch"/);
  assert.equal(tool.inputSchema.properties.source.const, "monarch");
});

test("connector amount bounds accept the last cent and reject the next dollar magnitude", () => {
  const limit = 10 ** 10;
  for (const sign of [-1, 1]) {
    const amount = sign * (limit - 0.01);
    assert.equal(fromConnector([{ ...transaction, amount }], { source: "monarch" })[0]?.amount, (-amount).toFixed(2));
    assert.throws(() => fromConnector([{ ...transaction, amount: sign * limit }], { source: "monarch" }));
  }
});
