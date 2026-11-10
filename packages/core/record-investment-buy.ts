import type pg from "pg";
import * as z from "zod";

export const recordInvestmentBuySchema = z
  .object({
    request_id: z.uuid(),
    state: z.enum(["planned", "completed"]),
    symbol: z.string().trim().min(1),
    account_ref: z.string().trim().min(1),
    planned_on: z.iso.date().nullish(),
    planned_condition: z.string().trim().min(1).nullish(),
    executed_on: z.iso.date().nullish(),
    amount: z
      .string()
      .regex(/^\d{1,12}(\.\d{1,2})?$/)
      .refine((v) => /[1-9]/.test(v), "Amount must be positive")
      .nullish(),
  })
  .refine(
    (v) =>
      v.state === "completed"
        ? v.executed_on != null && v.amount != null
        : (v.planned_on != null || v.planned_condition != null) && v.executed_on == null,
    "Completed buys require executed_on and amount; planned buys require planned_on or planned_condition and no executed_on",
  );

export async function recordInvestmentBuy(
  db: pg.ClientBase | pg.Pool,
  input: z.infer<typeof recordInvestmentBuySchema>,
) {
  const { rows } = await db.query<{ id: string }>(
    `insert into investment_buys (request_id, state, symbol, account_ref, planned_on, planned_condition, executed_on, amount)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (request_id) do nothing returning id::text`,
    [
      input.request_id,
      input.state,
      input.symbol,
      input.account_ref,
      input.planned_on ?? null,
      input.planned_condition ?? null,
      input.executed_on ?? null,
      input.amount ?? null,
    ],
  );
  const stored =
    rows[0] ??
    (await db.query<{ id: string }>("select id::text from investment_buys where request_id = $1", [input.request_id]))
      .rows[0];
  if (!stored) throw new Error("Stored investment buy not found");
  return { id: stored.id, already_existed: rows.length === 0 };
}
