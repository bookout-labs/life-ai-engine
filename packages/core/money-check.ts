import type pg from "pg";
import { z } from "zod";
import { type Bill, billsDue } from "./bills.ts";
import { cents, decimal } from "./money.ts";

const OVERDUE_LOOKBACK_DAYS = 60;
export const MONEY_CHECK_DAYS = 7;

const amountSchema = z.string().regex(/^\d+(?:\.\d{1,2})?$/);
const obligationSchema = z.object({
  id: z.string(),
  name: z.string(),
  day_is_estimate: z.boolean(),
  pays_from: z.string().nullable(),
  ended_on: z.iso.date().nullable(),
});
const chargeSchema = z.object({
  obligation_id: z.string(),
  due_on: z.iso.date(),
  amount: amountSchema,
  amount_is_estimate: z.boolean(),
  paid_on: z.iso.date().nullable(),
});
export type MoneyObligation = z.infer<typeof obligationSchema>;
export type MoneyCharge = z.infer<typeof chargeSchema>;
const itemSchema = z.object({
  obligation_id: z.string(),
  name: z.string(),
  due_on: z.iso.date(),
  amount: amountSchema.nullable(),
  amount_is_estimate: z.boolean(),
  day_is_estimate: z.boolean(),
  pays_from: z.string().nullable(),
});
export const moneyCheckSchema = z.object({
  from: z.iso.date(),
  through: z.iso.date(),
  due_soon: z.array(
    z.object({
      day: z.string(),
      name: z.string(),
      amount: amountSchema.nullable(),
      amount_is_estimate: z.boolean(),
      day_is_estimate: z.boolean(),
      pays_from: z.string().nullable(),
    }),
  ),
  overdue: z.array(itemSchema),
  stale_unpaid: z.number().int(),
  price_increases: z.array(
    z.object({
      obligation_id: z.string(),
      name: z.string(),
      previous_due_on: z.iso.date(),
      due_on: z.iso.date(),
      old_amount: amountSchema,
      new_amount: amountSchema,
      percent: amountSchema.nullable(),
    }),
  ),
  totals: z.object({
    due_soon: amountSchema,
    overdue: amountSchema,
    due_soon_unknown: z.number().int(),
  }),
});
export type MoneyCheck = z.infer<typeof moneyCheckSchema>;

export function buildMoneyCheck(
  obligations: readonly MoneyObligation[],
  charges: readonly MoneyCharge[],
  from: string,
  bills: readonly Bill[],
): MoneyCheck {
  const start = new Date(`${from}T00:00:00Z`);
  const through = new Date(start.getTime() + (MONEY_CHECK_DAYS - 1) * 86400000).toISOString().slice(0, 10);
  const overdueFrom = new Date(start.getTime() - OVERDUE_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
  let stale_unpaid = 0;

  const overdue: MoneyCheck["overdue"] = [];
  const price_increases: MoneyCheck["price_increases"] = [];
  const byObligation = new Map<string, MoneyCharge[]>();
  for (const charge of charges) {
    const history = byObligation.get(charge.obligation_id) ?? [];
    history.push(charge);
    byObligation.set(charge.obligation_id, history);
  }
  for (const obligation of obligations) {
    const history = (byObligation.get(obligation.id) ?? []).toSorted((a, b) => a.due_on.localeCompare(b.due_on));
    const item = (due_on: string, amount: string | null, estimate: boolean) => ({
      obligation_id: obligation.id,
      name: obligation.name,
      due_on,
      amount: amount === null ? null : decimal(cents(amount)),
      amount_is_estimate: estimate,
      day_is_estimate: obligation.day_is_estimate,
      pays_from: obligation.pays_from,
    });
    for (const charge of history) {
      if (charge.paid_on !== null) continue;
      const entry = item(charge.due_on, charge.amount, charge.amount_is_estimate);
      if (charge.due_on < overdueFrom) stale_unpaid++;
      else if (charge.due_on < from) overdue.push(entry);
    }
    if (obligation.ended_on !== null) continue;
    const confirmed = history.filter((charge) => !charge.amount_is_estimate && charge.due_on <= through);
    const current = confirmed.at(-1);
    const previous = confirmed.at(-2);
    if (current && previous && current.due_on >= overdueFrom && cents(current.amount) > cents(previous.amount)) {
      const old = cents(previous.amount);
      const increase = cents(current.amount) - old;
      price_increases.push({
        obligation_id: obligation.id,
        name: obligation.name,
        previous_due_on: previous.due_on,
        due_on: current.due_on,
        old_amount: decimal(old),
        new_amount: decimal(cents(current.amount)),
        percent: old === 0n ? null : decimal((increase * 10000n + old / 2n) / old),
      });
    }
  }
  const order = (a: { due_on: string; obligation_id: string }, b: { due_on: string; obligation_id: string }) =>
    a.due_on.localeCompare(b.due_on) ||
    (BigInt(a.obligation_id) < BigInt(b.obligation_id)
      ? -1
      : BigInt(a.obligation_id) > BigInt(b.obligation_id)
        ? 1
        : 0);
  const total = (items: readonly { amount: string | null }[]) =>
    decimal(items.reduce((sum, entry) => sum + (entry.amount === null ? 0n : cents(entry.amount)), 0n));
  return {
    from,
    through,
    due_soon: [...bills],
    overdue: overdue.sort(order),
    stale_unpaid,
    price_increases: price_increases.sort(order),
    totals: {
      due_soon: total(bills),
      overdue: total(overdue),
      due_soon_unknown: bills.filter((entry) => entry.amount === null).length,
    },
  };
}

// Supplied bills belong to the caller's read-only snapshot, as in readToday.
export async function readMoneyCheck(db: pg.ClientBase, from: string, bills?: Bill[]): Promise<MoneyCheck> {
  z.iso.date().parse(from);
  if (!bills) await db.query("begin isolation level repeatable read read only");
  try {
    const dueSoon = bills ?? (await billsDue(db, from, MONEY_CHECK_DAYS));
    const { rows } = await db.query(`select
    (select coalesce(jsonb_agg(o), '[]'::jsonb) from (
      select id::text, name, day_is_estimate, pays_from, ended_on::text
      from obligations
    ) o) as obligations,
    (select coalesce(jsonb_agg(c), '[]'::jsonb) from (
      select c.obligation_id::text, c.due_on::text, c.amount::text, c.amount_is_estimate, c.paid_on::text
      from charges c
    ) c) as charges`);
    const snapshot = z
      .object({ obligations: z.array(obligationSchema), charges: z.array(chargeSchema) })
      .parse(rows[0]);
    const result = buildMoneyCheck(snapshot.obligations, snapshot.charges, from, dueSoon);
    if (!bills) await db.query("commit");
    return result;
  } catch (error) {
    if (!bills) await db.query("rollback");
    throw error;
  }
}
