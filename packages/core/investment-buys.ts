import type pg from "pg";
import * as z from "zod";

const common = {
  id: z.string(),
  symbol: z.string(),
  account_ref: z.string(),
  planned_on: z.string().nullable(),
  planned_condition: z.string().nullable(),
};
const buySchema = z.discriminatedUnion("state", [
  z.object({ ...common, state: z.literal("planned"), executed_on: z.null(), amount: z.string().nullable() }),
  z.object({ ...common, state: z.literal("completed"), executed_on: z.string(), amount: z.string() }),
]);

export async function investmentBuys(db: pg.ClientBase | pg.Pool) {
  const { rows } = await db.query(
    `select id::text, state, symbol, account_ref, planned_on::text, planned_condition,
            executed_on::text, amount::text
       from investment_buys
      order by coalesce(executed_on, planned_on) nulls last, investment_buys.id`,
  );
  const buys = z.array(buySchema).parse(rows);
  return {
    planned: buys.filter((buy) => buy.state === "planned"),
    completed: buys.filter((buy) => buy.state === "completed"),
  };
}
