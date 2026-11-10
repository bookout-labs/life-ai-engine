import type pg from "pg";
import { z } from "zod";
import { InputError } from "./input-error.ts";
import { today } from "./schedule.ts";

const id = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const merchant = z
  .string()
  .min(1)
  .max(1000)
  .refine((value) => value === value.trim(), "Use the exact trimmed transaction merchant.");
export const subscriptionsCheckSchema = z.object({ as_of: z.iso.date().optional() });
export const linkSubscriptionMerchantSchema = z.object({
  request_id: z.uuid(),
  obligation_id: id,
  merchant,
  action: z.enum(["link", "unlink"]),
});
const linkSchema = z.object({ obligation_id: id, merchant });
const savedSchema = linkSchema.extend({ linked: z.boolean() });
const obligationSchema = z.object({
  id,
  name: z.string(),
  cadence: z.enum(["monthly", "yearly"]),
  due_day: z.number().int().nullable(),
  due_month: z.number().int().nullable(),
  pays_from: z.string().nullable(),
  ended_on: z.iso.date().nullable(),
});
const transactionSchema = z.object({
  source: z.string(),
  source_id: z.string(),
  posted_on: z.iso.date(),
  amount: z.string().regex(/^-?\d+(?:\.\d{1,2})?$/),
  merchant: z.string(),
  account_ref: z.string(),
  pending: z.boolean(),
  exclusion_reason: z.string().nullable(),
});
type Transaction = z.infer<typeof transactionSchema>;
type SubscriptionStatus = "charged_this_cycle" | "missing_this_cycle" | "not_linked" | "yearly_unknown";

const MONTHLY_MIN_DAYS = 25;
const MONTHLY_MAX_DAYS = 35;
const MIN_CHARGES = 2;
const AMOUNT_TOLERANCE_BPS = 500n;
const DAY_MS = 86400000;
function cents(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}
const dayNumber = (value: string) => Date.parse(`${value}T00:00:00Z`) / DAY_MS;
const eligible = (row: Transaction, asOf: string) =>
  !row.pending &&
  row.exclusion_reason === null &&
  !row.amount.startsWith("-") &&
  cents(row.amount) > 0n &&
  row.posted_on <= asOf;
const order = (a: Transaction, b: Transaction) =>
  a.posted_on.localeCompare(b.posted_on) || a.source.localeCompare(b.source) || a.source_id.localeCompare(b.source_id);
function evidence(row: Transaction) {
  return {
    source: row.source,
    source_id: row.source_id,
    posted_on: row.posted_on,
    amount: row.amount,
    account_ref: row.account_ref,
    merchant: row.merchant,
  };
}

// Every consecutive debit must fit, so weekly shopping cannot qualify through a cherry-picked monthly pair.
function recurringMerchants(rows: readonly Transaction[], links: readonly z.infer<typeof linkSchema>[], asOf: string) {
  const linked = new Set(links.map((entry) => entry.merchant));
  const groups = new Map<string, Transaction[]>();
  for (const row of rows) {
    if (!eligible(row, asOf) || linked.has(row.merchant)) continue;
    const history = groups.get(row.merchant) ?? [];
    history.push(row);
    groups.set(row.merchant, history);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([merchant, history]) => {
      history.sort(order);
      const last = history.at(-1);
      if (history.length < MIN_CHARGES || !last || dayNumber(asOf) - dayNumber(last.posted_on) > MONTHLY_MAX_DAYS)
        return [];
      for (let i = 1; i < history.length; i++) {
        const previous = history[i - 1];
        const current = history[i];
        if (!previous || !current) continue;
        const gap = dayNumber(current.posted_on) - dayNumber(previous.posted_on);
        if (gap < MONTHLY_MIN_DAYS || gap > MONTHLY_MAX_DAYS) return [];
      }
      const amounts = history.map((row) => cents(row.amount));
      const low = amounts.reduce((a, b) => {
        if (a < b) return a;
        return b;
      });
      const high = amounts.reduce((a, b) => {
        if (a > b) return a;
        return b;
      });
      if ((high - low) * 10000n > low * AMOUNT_TOLERANCE_BPS) return [];
      return [{ merchant, cadence: "monthly" as const, evidence: history.map(evidence) }];
    });
}

function cycle(obligation: z.infer<typeof obligationSchema>, asOf: string) {
  const now = new Date(`${asOf}T00:00:00Z`);
  const due = (year: number, month: number) => {
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(obligation.due_day ?? 1, last))).toISOString().slice(0, 10);
  };
  let year = now.getUTCFullYear();
  let month = obligation.cadence === "yearly" ? (obligation.due_month ?? 1) - 1 : now.getUTCMonth();
  if (due(year, month) > asOf) {
    if (obligation.cadence === "yearly") year--;
    else month--;
  }
  const from = due(year, month);
  const next = obligation.cadence === "yearly" ? due(year + 1, month) : due(year, month + 1);
  return { from, through: new Date(Date.parse(`${next}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10) };
}

export function buildSubscriptionsCheck(
  obligations: readonly z.infer<typeof obligationSchema>[],
  links: readonly z.infer<typeof linkSchema>[],
  transactions: readonly Transaction[],
  asOf: string,
) {
  const debits = transactions.filter((row) => eligible(row, asOf)).toSorted(order);
  const subscriptions = obligations
    .filter((row) => row.ended_on === null)
    .map((obligation) => {
      const merchants = links
        .filter((entry) => entry.obligation_id === obligation.id)
        .map((entry) => entry.merchant)
        .sort();
      const history = debits.filter((row) => merchants.includes(row.merchant));
      const last = history.at(-1);
      const previous = history.at(-2);
      const interval = cycle(obligation, asOf);
      const charged = history.some((row) => row.posted_on >= interval.from && row.posted_on <= interval.through);
      const status: SubscriptionStatus = !merchants.length
        ? "not_linked"
        : charged
          ? "charged_this_cycle"
          : obligation.cadence === "yearly"
            ? "yearly_unknown"
            : "missing_this_cycle";
      return {
        obligation_id: obligation.id,
        name: obligation.name,
        cadence: obligation.cadence,
        linked_merchants: merchants,
        expected_pays_from: obligation.pays_from,
        cycle_from: interval.from,
        cycle_through: interval.through,
        cycle_day_is_assumed: obligation.due_day === null,
        status,
        last_charge: last ? evidence(last) : null,
        previous_amount: previous?.amount ?? null,
        price_changed: last && previous ? cents(last.amount) !== cents(previous.amount) : false,
      };
    });
  return {
    as_of: asOf,
    subscriptions,
    missing_this_cycle: subscriptions.filter((row) => row.status === "missing_this_cycle"),
    unrecorded_recurring_merchants: recurringMerchants(transactions, links, asOf),
    notes: [
      "USD expenses are positive. Refunds, credits, pending and excluded transactions never count as charges. Results reflect imported transactions only; missing does not establish cancellation.",
      "A cycle starts on the latest scheduled due date on or before as_of and ends before the next due date. Due days clamp to month end. Missing due_day assumes day 1 and is flagged. Early postings may fall in the prior cycle.",
      "Yearly recurrence cannot yet be detected from the short imported history. A linked yearly subscription without a charge in its cycle is yearly_unknown, not evidence of cancellation.",
      `Monthly candidates need at least ${MIN_CHARGES} debits, every consecutive gap ${MONTHLY_MIN_DAYS}-${MONTHLY_MAX_DAYS} days, a last debit within ${MONTHLY_MAX_DAYS} days and a total amount range within ${AMOUNT_TOLERANCE_BPS / 100n}% of the minimum. Exact merchants only; all obligation links exclude candidates. Evidence requires human confirmation.`,
      "Price change compares the last two eligible debits across linked merchants and accounts. Multiple charges or account moves require human confirmation.",
    ],
  };
}

export async function subscriptionsCheck(db: pg.ClientBase, input: z.input<typeof subscriptionsCheckSchema> = {}) {
  const { as_of = today() } = subscriptionsCheckSchema.parse(input);
  await db.query("begin isolation level repeatable read read only");
  try {
    const obligations = await db.query(
      "select id::text, name, cadence, due_day, due_month, pays_from, ended_on::text from obligations where kind = 'subscription' and ended_on is null order by obligations.id",
    );
    const links = await db.query("select obligation_id::text, merchant from obligation_merchants order by merchant");
    const transactions = await db.query(
      "select source, source_id, posted_on::text, amount::text, merchant, account_ref, pending, exclusion_reason from transactions where posted_on <= $1::date",
      [as_of],
    );
    const result = buildSubscriptionsCheck(
      z.array(obligationSchema).parse(obligations.rows),
      z.array(linkSchema).parse(links.rows),
      z.array(transactionSchema).parse(transactions.rows),
      as_of,
    );
    await db.query("commit");
    return result;
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}

// Dedicated client, like the other request-ledger writes. The lock also serializes competing merchant claims.
export async function linkSubscriptionMerchant(db: pg.ClientBase, input: unknown) {
  const value = linkSubscriptionMerchantSchema.parse(input);
  await db.query("begin");
  try {
    const claim = await db.query(
      "insert into obligation_merchant_requests(request_id, result) values ($1, '{}') on conflict do nothing returning request_id",
      [value.request_id],
    );
    if (!claim.rows.length) {
      const stored = await db.query("select result from obligation_merchant_requests where request_id = $1", [
        value.request_id,
      ]);
      const result = savedSchema.parse(stored.rows[0]?.result);
      await db.query("commit");
      return result;
    }
    await db.query("lock table obligation_merchants in share row exclusive mode");
    const obligation = await db.query("select kind from obligations where id = $1 for share", [value.obligation_id]);
    if (!obligation.rows.length) throw new InputError(`Obligation ${value.obligation_id} not found.`);
    if (!["subscription", "bill"].includes(obligation.rows[0].kind))
      throw new InputError("Only subscription or bill obligations can link merchants.");
    const existing = await db.query("select obligation_id::text from obligation_merchants where merchant = $1", [
      value.merchant,
    ]);
    if (existing.rows.length && existing.rows[0].obligation_id !== value.obligation_id)
      throw new InputError("Merchant is already linked to another obligation. Unlink it there first.");
    if (value.action === "link")
      await db.query(
        "insert into obligation_merchants(obligation_id, merchant) values ($1,$2) on conflict do nothing",
        [value.obligation_id, value.merchant],
      );
    else
      await db.query("delete from obligation_merchants where obligation_id = $1 and merchant = $2", [
        value.obligation_id,
        value.merchant,
      ]);
    const result = { obligation_id: value.obligation_id, merchant: value.merchant, linked: value.action === "link" };
    await db.query("update obligation_merchant_requests set result = $2 where request_id = $1", [
      value.request_id,
      result,
    ]);
    await db.query("commit");
    return result;
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}
