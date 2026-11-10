import { z } from "zod";
import type { SpendingTransaction } from "./spending.ts";

const exclusion = z.enum(["transfer", "income", "hidden"]);
const text = z.string().trim().min(1);
const id = z.string().regex(/^\d+$/);
const connectorTransaction = z.object({
  id,
  date: z.iso.date(),
  pending: z.boolean(),
  merchant: text,
  merchant_id: id,
  amount: z
    .number()
    .refine((value) => Math.abs(value) < 1e10)
    .refine((value) => Number(value.toFixed(2)) === value),
  formatted_amount: z.string(),
  category: text,
  category_id: id,
  account: z.string(),
  account_id: id,
});

// Connector default category names. User-renamed categories need an explicit override.
const defaults: Record<string, z.infer<typeof exclusion>> = {
  Transfer: "transfer",
  "Credit Card Payment": "transfer",
  "Balance Adjustments": "transfer",
  "Business Income": "income",
  "Other Income": "income",
  Paychecks: "income",
  Interest: "income",
};
export const importTransactionsSchema = z.object({
  source: z.literal("monarch"),
  hidden: z.boolean().optional(),
  exclude: z.record(z.string(), exclusion).optional(),
  transactions: z.array(connectorTransaction).max(100),
});

export function fromConnector(
  rows: unknown,
  options: Omit<z.infer<typeof importTransactionsSchema>, "transactions">,
): SpendingTransaction[] {
  const { transactions, source, hidden, exclude } = importTransactionsSchema.parse({ ...options, transactions: rows });
  const exclusions = new Map(
    Object.entries({ ...defaults, ...exclude }).map(([key, value]) => [key.trim().toLowerCase(), value]),
  );
  return transactions.map((row) => ({
    source,
    source_id: row.id,
    posted_on: row.date,
    amount: (-row.amount).toFixed(2),
    merchant: row.merchant,
    category: row.category,
    account_ref: row.account_id,
    pending: row.pending,
    exclusion_reason: hidden ? "hidden" : (exclusions.get(row.category.toLowerCase()) ?? null),
  }));
}
