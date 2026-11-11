import type pg from "pg";
import { z } from "zod";
import { budgetTargets } from "./finances.ts";
import { cents, decimal } from "./money.ts";
import { today } from "./schedule.ts";

const text = z.string().trim().min(1);
// USD expenses are positive; refunds/credits are negative. Never take an absolute value on import.
const spendingTransactionSchema = z.object({
  source: text,
  source_id: text,
  posted_on: z.iso.date(),
  amount: z.string().regex(/^-?\d{1,10}(?:\.\d{1,2})?$/),
  merchant: text,
  category: text,
  account_ref: text,
  pending: z.boolean(),
  exclusion_reason: z.enum(["transfer", "hidden", "income"]).nullable(),
});
export type SpendingTransaction = z.infer<typeof spendingTransactionSchema>;
type BudgetTarget = Awaited<ReturnType<typeof budgetTargets>>[number];
export const spendingInputSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  category: text.optional(),
});

// Requires a dedicated connected client, not a pool or an existing transaction.
export async function importSpending(db: pg.ClientBase, input: readonly SpendingTransaction[]) {
  const rows = z
    .array(spendingTransactionSchema)
    .parse(input)
    .sort((a, b) =>
      a.source < b.source
        ? -1
        : a.source > b.source
          ? 1
          : a.source_id < b.source_id
            ? -1
            : a.source_id > b.source_id
              ? 1
              : 0,
    );
  let inserted = 0;
  let updated = 0;
  await db.query("begin");
  try {
    for (const row of rows) {
      const result = await db.query<{ inserted: boolean }>(
        `insert into transactions (source, source_id, posted_on, amount, merchant, category, account_ref, pending, exclusion_reason)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (source, source_id) do update set
           posted_on = excluded.posted_on, amount = excluded.amount, merchant = excluded.merchant,
           category = excluded.category, account_ref = excluded.account_ref, pending = excluded.pending,
           exclusion_reason = excluded.exclusion_reason
         where (transactions.posted_on, transactions.amount, transactions.merchant, transactions.category,
           transactions.account_ref, transactions.pending, transactions.exclusion_reason)
         is distinct from (excluded.posted_on, excluded.amount, excluded.merchant, excluded.category,
           excluded.account_ref, excluded.pending, excluded.exclusion_reason)
         returning (old.source is null) as inserted`,
        [
          row.source,
          row.source_id,
          row.posted_on,
          row.amount,
          row.merchant,
          row.category,
          row.account_ref,
          row.pending,
          row.exclusion_reason,
        ],
      );
      if (result.rows[0]?.inserted) inserted++;
      else if (result.rowCount) updated++;
    }
    await db.query("commit");
    return {
      processed: rows.length,
      inserted,
      updated,
      excluded: rows.filter((row) => row.exclusion_reason !== null).length,
    };
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}

// Conservative attention cues, not fraud detection. Baselines use only loaded, prior-month positive charges.
const unusualRules = [
  { rule: "above_typical", minimum_history: 3, multiple: 3n, floor: 10000n },
  { rule: "first_seen", minimum_history: 0, multiple: 0n, floor: 10000n },
] as const;

export function buildSpending(
  rows: readonly SpendingTransaction[],
  targets: readonly BudgetTarget[],
  input: z.infer<typeof spendingInputSchema>,
  asOf: string,
) {
  const { month, category } = input;
  const start = `${month}-01`;
  const days = new Date(`${start}T00:00:00Z`);
  days.setUTCMonth(days.getUTCMonth() + 1);
  days.setUTCDate(0);
  const last = days.toISOString().slice(0, 10);
  const through = asOf < last ? asOf : last;
  const elapsed = through < start ? 0 : Number(through.slice(8, 10));
  const daysInMonth = days.getUTCDate();
  const eligible = rows.filter((row) => !row.pending && row.exclusion_reason === null && row.posted_on <= through);
  const matchesCategory = (name: string) => !category || name.trim().toLowerCase() === category.trim().toLowerCase();
  const current = eligible.filter((row) => row.posted_on >= start && matchesCategory(row.category));
  const historyCutoff = new Date(`${start}T00:00:00Z`);
  historyCutoff.setUTCDate(historyCutoff.getUTCDate() - 90);
  const coveredSources = new Set(
    rows.filter((row) => row.posted_on <= historyCutoff.toISOString().slice(0, 10)).map((row) => row.source),
  );
  const sum = (items: readonly SpendingTransaction[]) => items.reduce((total, row) => total + cents(row.amount), 0n);
  const categories = [...new Set([...current.map((row) => row.category), ...targets.map((target) => target.category)])]
    .filter(matchesCategory)
    .sort();
  const byCategory = categories.map((name) => {
    const spend = sum(current.filter((row) => row.category === name));
    const target = targets.find((entry) => entry.category === name);
    const scaled = (amount: string) =>
      (cents(amount) * BigInt(elapsed) + BigInt(Math.floor(daysInMonth / 2))) / BigInt(daysInMonth);
    return {
      category: name,
      spend: decimal(spend),
      target: target
        ? {
            monthly_min: target.monthly_min,
            monthly_max: target.monthly_max,
            status: target.status,
            is_estimate: target.is_estimate,
            paced_min: decimal(scaled(target.monthly_min)),
            paced_max: decimal(scaled(target.monthly_max)),
            above_pace: spend > scaled(target.monthly_max),
          }
        : null,
    };
  });
  const merchants = [...new Set(current.map((row) => row.merchant))]
    .map((merchant) => ({
      merchant,
      spend: decimal(sum(current.filter((row) => row.merchant === merchant))),
    }))
    .sort((a, b) =>
      cents(a.spend) > cents(b.spend) ? -1 : cents(a.spend) < cents(b.spend) ? 1 : a.merchant.localeCompare(b.merchant),
    )
    .slice(0, 10);
  const unusual = current
    .filter((row) => cents(row.amount) > 0n)
    .flatMap((row) => {
      const history = eligible
        .filter((entry) => entry.merchant === row.merchant && entry.posted_on < start && cents(entry.amount) > 0n)
        .map((entry) => cents(entry.amount))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const middle = Math.floor(history.length / 2);
      const medianTwice =
        history.length % 2 ? (history[middle] ?? 0n) * 2n : (history[middle - 1] ?? 0n) + (history[middle] ?? 0n);
      const seenEarlier = eligible.some(
        (entry) =>
          entry.merchant === row.merchant &&
          cents(entry.amount) > 0n &&
          (entry.posted_on < row.posted_on ||
            (entry.posted_on === row.posted_on &&
              `${entry.source}\u0000${entry.source_id}` < `${row.source}\u0000${row.source_id}`)),
      );
      return unusualRules
        .filter(
          (rule) =>
            cents(row.amount) >= rule.floor &&
            (rule.rule === "first_seen"
              ? coveredSources.has(row.source) && !seenEarlier
              : history.length >= rule.minimum_history && cents(row.amount) * 2n >= medianTwice * rule.multiple),
        )
        .map((rule) => ({
          source: row.source,
          source_id: row.source_id,
          posted_on: row.posted_on,
          merchant: row.merchant,
          category: row.category,
          amount: decimal(cents(row.amount)),
          rule: rule.rule,
          prior_charge_count: history.length,
        }));
    })
    .sort(
      (a, b) =>
        a.posted_on.localeCompare(b.posted_on) ||
        a.source.localeCompare(b.source) ||
        a.source_id.localeCompare(b.source_id),
    );
  return {
    month,
    as_of: asOf,
    days_elapsed: elapsed,
    days_in_month: daysInMonth,
    total: decimal(sum(current)),
    categories: byCategory,
    top_merchants: merchants,
    unusual,
    notes: [
      "USD. Expenses positive; refunds negative. Business accounts, pending, transfers, hidden and income excluded. Unknown-scope and unmapped accounts included.",
      "Draft targets are proposals. Pace is the monthly target times elapsed calendar days, rounded to cents.",
      ...([...new Set(rows.map((row) => row.source))].some((source) => !coveredSources.has(source)) || rows.length === 0
        ? [
            "First-seen suppressed for sources without loaded history starting at least 90 days before the report month.",
          ]
        : []),
      "Both unusual rules require at least USD 100. Above-typical means at least 3 times the prior-month median with 3 prior positive charges. First-seen means the first positive charge at a merchant in loaded history, only when that source has at least 90 days of history before the month starts. Incomplete imports limit these cues; totals reflect only imported rows.",
    ],
  };
}

export async function readSpending(db: pg.ClientBase, input: z.infer<typeof spendingInputSchema>, asOf = today()) {
  const parsed = spendingInputSchema.parse(input);
  z.iso.date().parse(asOf);
  await db.query("begin isolation level repeatable read read only");
  try {
    const { rows } = await db.query(
      `select source, source_id, posted_on::text, amount::text,
      merchant, category, account_ref, pending, exclusion_reason from household_transactions where posted_on <= $1::date`,
      [asOf],
    );
    const result = buildSpending(z.array(spendingTransactionSchema).parse(rows), await budgetTargets(db), parsed, asOf);
    await db.query("commit");
    return result;
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}
