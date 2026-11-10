import assert from "node:assert/strict";
import test from "node:test";
import { fromConnector } from "./spending-import.ts";

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
    { source: "synthetic" },
  );
  assert.deepEqual(row, {
    source: "synthetic",
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
    assert.throws(() => fromConnector([{ ...transaction, amount }], { source: "synthetic" }));
  }
  assert.throws(() => fromConnector([{ ...transaction, date: "invalid" }], { source: "synthetic" }));
  assert.throws(() => fromConnector(Array(101).fill(transaction), { source: "synthetic" }));
});

test("connector defaults, custom exclusions and hidden batches preserve spending policy", () => {
  const rows = ["Transfer", "Credit Card Payment", "Paychecks", "Interest", "Renamed", "Food", "toString"].map(
    (category) => ({ ...transaction, category }),
  );
  assert.deepEqual(
    fromConnector(rows, { source: "synthetic", exclude: { Renamed: "transfer", Interest: "transfer" } }).map(
      (row) => row.exclusion_reason,
    ),
    ["transfer", "transfer", "income", "transfer", "transfer", null, null],
  );
  assert.ok(
    fromConnector(rows, { source: "synthetic", hidden: true }).every((row) => row.exclusion_reason === "hidden"),
  );
});
