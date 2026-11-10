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
const savedSchema = linkSchema.extend({ linked: z.boolean(), warning: z.string().optional() });
const obligationSchema = z.object({
  id,
  name: z.string(),
  cadence: z.enum(["monthly", "yearly"]),
  due_day: z.number().int().nullable(),
  day_is_estimate: z.boolean().default(false),
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
const receiptSchema = z.object({
  obligation_id: id,
  posted_on: z.iso.date(),
  amount: z
    .string()
    .regex(/^\d+(?:\.\d{1,2})?$/)
    .refine((value) => cents(value) > 0n && cents(value) <= 999999999999n),
  source_ref: z.string().min(1).max(4000),
});
type Receipt = z.infer<typeof receiptSchema>;
type Charge = Transaction | (Receipt & { source: "receipt"; source_id: string });
type Transaction = z.infer<typeof transactionSchema>;
type SubscriptionStatus = "charged_this_cycle" | "missing_this_cycle" | "not_linked" | "yearly_unknown";

const MONTHLY_MIN_DAYS = 25;
const MONTHLY_MAX_DAYS = 35;
const MIN_CHARGES = 2;
const TWO_MONTH_MIN_DAYS = 55;
const TWO_MONTH_MAX_DAYS = 70;
const DUPLICATE_WINDOW_DAYS = 3;
const AMOUNT_TOLERANCE_BPS = 1000n;
const BASIS_POINTS = 10000n;
const EARLY_GRACE_DAYS = 5;
const ESTIMATED_EARLY_GRACE_DAYS = 7;
const DAY_MS = 86400000;
function cents(value: string): bigint {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = value.replace(/^-/, "").split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return negative ? -amount : amount;
}
const dayNumber = (value: string) => Date.parse(`${value}T00:00:00Z`) / DAY_MS;
const eligible = (row: Transaction, asOf: string) =>
  !row.pending && row.exclusion_reason === null && cents(row.amount) > 0n && row.posted_on <= asOf;
const order = (a: Charge, b: Charge) =>
  a.posted_on.localeCompare(b.posted_on) || a.source.localeCompare(b.source) || a.source_id.localeCompare(b.source_id);
function evidence(row: Charge) {
  return {
    source: row.source,
    source_id: row.source_id,
    posted_on: row.posted_on,
    amount: row.amount,
    account_ref: "obligation_id" in row ? null : row.account_ref,
    merchant: "obligation_id" in row ? null : row.merchant,
  };
}

// Keep every occurrence in the spacing check, so weekly shopping cannot qualify through a monthly pair.
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
      const occurrences: Transaction[] = [];
      for (const row of history) {
        const previous = occurrences.at(-1);
        if (!previous || dayNumber(row.posted_on) - dayNumber(previous.posted_on) > DUPLICATE_WINDOW_DAYS)
          occurrences.push(row);
      }
      const last = history.at(-1);
      if (occurrences.length < MIN_CHARGES || !last) return [];
      let latestGap = 0;
      for (let i = 1; i < occurrences.length; i++) {
        const previous = occurrences[i - 1];
        const current = occurrences[i];
        if (!previous || !current) continue;
        const gap = dayNumber(current.posted_on) - dayNumber(previous.posted_on);
        if (
          !(gap >= MONTHLY_MIN_DAYS && gap <= MONTHLY_MAX_DAYS) &&
          !(gap >= TWO_MONTH_MIN_DAYS && gap <= TWO_MONTH_MAX_DAYS)
        )
          return [];
        const before = cents(previous.amount);
        const change = cents(current.amount) - before;
        if ((change < 0n ? -change : change) * BASIS_POINTS > before * AMOUNT_TOLERANCE_BPS) return [];
        latestGap = gap;
      }
      const recentDays = latestGap >= TWO_MONTH_MIN_DAYS ? TWO_MONTH_MAX_DAYS : MONTHLY_MAX_DAYS;
      if (dayNumber(asOf) - dayNumber(last.posted_on) > recentDays) return [];
      return [{ merchant, cadence: "monthly" as const, evidence: history.map(evidence) }];
    });
}

function cycle(obligation: z.infer<typeof obligationSchema>, asOf: string, reference: "posting" | "due" = "posting") {
  const now = new Date(`${asOf}T00:00:00Z`);
  const due = (year: number, month: number, shifted = true) => {
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const grace =
      obligation.cadence === "monthly" && shifted
        ? obligation.day_is_estimate
          ? ESTIMATED_EARLY_GRACE_DAYS
          : EARLY_GRACE_DAYS
        : 0;
    return new Date(Date.UTC(year, month, Math.min(obligation.due_day ?? 1, last)) - grace * DAY_MS)
      .toISOString()
      .slice(0, 10);
  };
  let year = now.getUTCFullYear();
  let month = obligation.cadence === "yearly" ? (obligation.due_month ?? 1) - 1 : now.getUTCMonth();
  const shifted = reference === "posting";
  if (obligation.cadence === "monthly" && due(year, month + 1, shifted) <= asOf) month++;
  if (due(year, month, shifted) > asOf) {
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
  receipts: readonly Receipt[] = [],
) {
  const receiptCharges = receipts
    .filter((row) => row.posted_on <= asOf)
    .map((row) => ({ ...row, source: "receipt" as const, source_id: row.source_ref }));
  const debits = transactions.filter((row) => eligible(row, asOf)).toSorted(order);
  const historyFor = (obligationId: string, merchants: string[]): Charge[] =>
    [
      ...debits.filter((row) => merchants.includes(row.merchant)),
      ...receiptCharges.filter((row) => row.obligation_id === obligationId),
    ].toSorted(order);
  const subscriptions = obligations
    .filter((row) => row.ended_on === null || row.ended_on >= asOf)
    .map((obligation) => {
      const merchants = links
        .filter((entry) => entry.obligation_id === obligation.id)
        .map((entry) => entry.merchant)
        .sort();
      const history = historyFor(obligation.id, merchants);
      const last = history.at(-1);
      const cycles = new Map<string, Charge[]>();
      for (const row of history) {
        const key = cycle(obligation, row.posted_on).from;
        const charges = cycles.get(key) ?? [];
        charges.push(row);
        cycles.set(key, charges);
      }
      const distinctCycles = [...cycles];
      const previous = distinctCycles.at(-2)?.[1].at(-1);
      const interval = cycle(obligation, asOf, "due");
      const charged = history.some((row) => row.posted_on >= interval.from && row.posted_on <= interval.through);
      const status: SubscriptionStatus =
        !merchants.length && !history.length
          ? "not_linked"
          : charged
            ? "charged_this_cycle"
            : obligation.cadence === "yearly" && !history.some((row) => "obligation_id" in row)
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
        duplicate_charges: distinctCycles
          .filter(([, charges]) => charges.length > 1)
          .map(([cycle_from, charges]) => ({
            cycle_from,
            dates: charges.map((row) => row.posted_on),
            evidence: charges.map(evidence),
          })),
        price_changed: last && previous ? cents(last.amount) !== cents(previous.amount) : false,
      };
    });
  return {
    as_of: asOf,
    subscriptions,
    charged_after_end: obligations.flatMap((obligation) => {
      if (obligation.ended_on === null || obligation.ended_on >= asOf) return [];
      const merchants = links.filter((entry) => entry.obligation_id === obligation.id).map((entry) => entry.merchant);
      const endedOn = obligation.ended_on;
      const charges = historyFor(obligation.id, merchants).filter((row) => row.posted_on > endedOn);
      return charges.length
        ? [
            {
              obligation_id: obligation.id,
              name: obligation.name,
              ended_on: obligation.ended_on,
              evidence: charges.map(evidence),
            },
          ]
        : [];
    }),
    missing_this_cycle: subscriptions.filter((row) => row.status === "missing_this_cycle"),
    unrecorded_recurring_merchants: recurringMerchants(transactions, links, asOf),
    notes: [
      "USD expenses are positive. Business-account charges are excluded from candidates and linked evidence. Unknown-scope and unmapped accounts are included. Refunds, credits, pending and excluded transactions never count as charges. Results reflect imported bank transactions and recorded email receipts only; missing does not establish cancellation.",
      `Monthly cycles start ${EARLY_GRACE_DAYS} days before the clamped due date, or ${ESTIMATED_EARLY_GRACE_DAYS} when day_is_estimate, and end before the next such boundary. Status uses the cycle of the latest clamped due date on or before as_of. Yearly cycles start on the clamped due date. Missing due_day assumes day 1 and is flagged.`,
      "Receipt evidence is labeled receipt and belongs only to its recorded obligation. Receipt charges never enter spending because bank transactions already hold the money movement. A receipt-evidenced plan with no charge in its cycle is missing_this_cycle. A bank debit and receipt for the same payment can appear as duplicate evidence; confirm privately.",
      "Yearly recurrence cannot yet be detected from the short imported history. A bank-only linked yearly subscription without a charge in its cycle is yearly_unknown, not evidence of cancellation.",
      `Monthly candidates need at least ${MIN_CHARGES} occurrences, grouping debits within ${DUPLICATE_WINDOW_DAYS} days of the occurrence's first debit. Gaps must be ${MONTHLY_MIN_DAYS}-${MONTHLY_MAX_DAYS} or ${TWO_MONTH_MIN_DAYS}-${TWO_MONTH_MAX_DAYS} days; the latest debit must be within ${MONTHLY_MAX_DAYS} days, or ${TWO_MONTH_MAX_DAYS} if the last gap was two months. Consecutive occurrence amounts (first debit) may differ by at most ${AMOUNT_TOLERANCE_BPS / 100n}% of the previous amount. Exact merchants only; all obligation links exclude candidates. Confirm evidence privately.`,
      "Price compares the latest charge in each of the last two distinct charged cycles, across linked merchants, accounts and receipts. Duplicate cycles expose every debit date and evidence. Subscriptions remain active through ended_on. Once ended_on is before as_of, subscriptions with debits strictly after ended_on appear in charged_after_end.",
    ],
  };
}

export async function subscriptionsCheck(db: pg.ClientBase, input: z.input<typeof subscriptionsCheckSchema> = {}) {
  const { as_of = today() } = subscriptionsCheckSchema.parse(input);
  await db.query("begin isolation level repeatable read read only");
  try {
    const obligations = await db.query(
      "select id::text, name, cadence, due_day, day_is_estimate, due_month, pays_from, ended_on::text from obligations where kind = 'subscription' order by obligations.id",
    );
    const links = await db.query("select obligation_id::text, merchant from obligation_merchants order by merchant");
    const transactions = await db.query(
      "select source, source_id, posted_on::text, amount::text, merchant, account_ref, pending, exclusion_reason from household_transactions where posted_on <= $1::date",
      [as_of],
    );
    const receipts = await db.query(
      "select obligation_id::text, posted_on::text, amount::text, source_ref from receipt_charges where posted_on <= $1::date",
      [as_of],
    );
    const result = buildSubscriptionsCheck(
      z.array(obligationSchema).parse(obligations.rows),
      z.array(linkSchema).parse(links.rows),
      z.array(transactionSchema).parse(transactions.rows),
      as_of,
      z.array(receiptSchema).parse(receipts.rows),
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
    const obligation = await db.query("select id from obligations where id = $1 for share", [value.obligation_id]);
    if (!obligation.rows.length) throw new InputError(`Obligation ${value.obligation_id} not found.`);
    const existing = await db.query("select obligation_id::text from obligation_merchants where merchant = $1", [
      value.merchant,
    ]);
    if (existing.rows.length && existing.rows[0].obligation_id !== value.obligation_id)
      throw new InputError(
        value.action === "unlink"
          ? `Merchant belongs to obligation ${existing.rows[0].obligation_id}; nothing was unlinked.`
          : "Merchant is already linked to another obligation. Unlink it there first.",
      );
    if (value.action === "unlink" && !existing.rows.length)
      throw new InputError(
        `Merchant ${value.merchant} is not linked to obligation ${value.obligation_id}; nothing was unlinked.`,
      );
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
    const matching =
      value.action === "link"
        ? await db.query("select 1 from household_transactions where merchant = $1 limit 1", [value.merchant])
        : null;
    const result = {
      obligation_id: value.obligation_id,
      merchant: value.merchant,
      linked: value.action === "link",
      ...(matching && !matching.rows.length
        ? {
            warning: `No matching transaction for merchant "${value.merchant}". Link saved; confirm the exact merchant spelling or wait for its first charge.`,
          }
        : {}),
    };
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

export const recordReceiptChargeSchema = receiptSchema.extend({ request_id: z.uuid() });

export async function recordReceiptCharge(db: pg.ClientBase, input: unknown) {
  const value = recordReceiptChargeSchema.parse(input);
  await db.query("begin");
  try {
    const claim = await db.query(
      "insert into receipt_charge_requests(request_id, result) values ($1, '{}') on conflict do nothing returning request_id",
      [value.request_id],
    );
    if (!claim.rows.length) {
      const stored = await db.query("select result from receipt_charge_requests where request_id = $1", [
        value.request_id,
      ]);
      const result = receiptSchema.parse(stored.rows[0]?.result);
      await db.query("commit");
      return result;
    }
    const obligation = await db.query("select kind from obligations where id = $1 for share", [value.obligation_id]);
    if (!obligation.rows.length) throw new InputError(`Obligation ${value.obligation_id} not found.`);
    if (obligation.rows[0].kind !== "subscription")
      throw new InputError(`Obligation ${value.obligation_id} is not a subscription.`);
    await db.query(
      "insert into receipt_charges(obligation_id, posted_on, amount, source_ref) values ($1,$2,$3,$4) on conflict do nothing",
      [value.obligation_id, value.posted_on, value.amount, value.source_ref],
    );
    const stored = await db.query(
      "select obligation_id::text, posted_on::text, amount::text, source_ref from receipt_charges where source_ref = $1",
      [value.source_ref],
    );
    const result = receiptSchema.parse(stored.rows[0]);
    if (
      result.obligation_id !== value.obligation_id ||
      result.posted_on !== value.posted_on ||
      cents(result.amount) !== cents(value.amount)
    )
      throw new InputError("Receipt source_ref already records a different charge.");
    await db.query("update receipt_charge_requests set result = $2 where request_id = $1", [value.request_id, result]);
    await db.query("commit");
    return result;
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}
