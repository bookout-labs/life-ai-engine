import type pg from "pg";
import { z } from "zod";

const amountSchema = z.string().regex(/^\d+(?:\.\d{1,2})?$/);
const obligationSchema = z.object({
  id: z.string(),
  name: z.string(),
  cadence: z.enum(["monthly", "yearly"]),
  due_day: z.number().int().min(1).max(31).nullable(),
  due_month: z.number().int().min(1).max(12).nullable(),
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
  due_soon: z.array(itemSchema),
  overdue: z.array(itemSchema),
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

function cents(amount: string): bigint {
  const [whole = "0", fraction = ""] = amount.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}
function decimal(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

export function buildMoneyCheck(
  obligations: readonly MoneyObligation[],
  charges: readonly MoneyCharge[],
  from: string,
): MoneyCheck {
  const start = new Date(`${from}T00:00:00Z`);
  const days = Array.from({ length: 7 }, (_, offset) =>
    new Date(start.getTime() + offset * 86400000).toISOString().slice(0, 10),
  );
  const through = days.at(-1) ?? from;
  const due_soon: MoneyCheck["due_soon"] = [];
  const overdue: MoneyCheck["overdue"] = [];
  const price_increases: MoneyCheck["price_increases"] = [];
  const byObligation = new Map<string, MoneyCharge[]>();
  for (const charge of charges) {
    const history = byObligation.get(charge.obligation_id) ?? [];
    history.push(charge);
    byObligation.set(charge.obligation_id, history);
  }
  for (const obligation of obligations) {
    if (obligation.ended_on !== null) continue;
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
      if (charge.due_on < from) overdue.push(entry);
      else if (charge.due_on <= through) due_soon.push(entry);
    }
    for (const day of days) {
      const date = new Date(`${day}T00:00:00Z`);
      const month = date.getUTCMonth() + 1;
      const lastDay = new Date(Date.UTC(date.getUTCFullYear(), month, 0)).getUTCDate();
      if (obligation.due_day === null || date.getUTCDate() !== Math.min(obligation.due_day, lastDay)) continue;
      if (obligation.cadence === "yearly" && obligation.due_month !== month) continue;
      if (history.some((charge) => charge.due_on === day)) continue;
      const previous = history.filter((charge) => charge.due_on < day).at(-1);
      due_soon.push(item(day, previous?.amount ?? null, true));
    }
    const confirmed = history.filter((charge) => !charge.amount_is_estimate && charge.due_on <= through);
    const current = confirmed.at(-1);
    const previous = confirmed.at(-2);
    if (current && previous && cents(current.amount) > cents(previous.amount)) {
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
    a.due_on.localeCompare(b.due_on) || a.obligation_id.localeCompare(b.obligation_id);
  const total = (items: MoneyCheck["due_soon"]) =>
    decimal(items.reduce((sum, entry) => sum + (entry.amount === null ? 0n : cents(entry.amount)), 0n));
  return {
    from,
    through,
    due_soon: due_soon.sort(order),
    overdue: overdue.sort(order),
    price_increases: price_increases.sort(order),
    totals: {
      due_soon: total(due_soon),
      overdue: total(overdue),
      due_soon_unknown: due_soon.filter((entry) => entry.amount === null).length,
    },
  };
}

export async function readMoneyCheck(db: pg.ClientBase, from: string): Promise<MoneyCheck> {
  z.iso.date().parse(from);
  const { rows } = await db.query(`select
    (select coalesce(jsonb_agg(o), '[]'::jsonb) from (
      select id::text, name, cadence, due_day, due_month, day_is_estimate, pays_from, ended_on::text
      from obligations where ended_on is null
    ) o) as obligations,
    (select coalesce(jsonb_agg(c), '[]'::jsonb) from (
      select c.obligation_id::text, c.due_on::text, c.amount::text, c.amount_is_estimate, c.paid_on::text
      from charges c join obligations o on o.id = c.obligation_id where o.ended_on is null
    ) c) as charges`);
  const snapshot = z.object({ obligations: z.array(obligationSchema), charges: z.array(chargeSchema) }).parse(rows[0]);
  return buildMoneyCheck(snapshot.obligations, snapshot.charges, from);
}
