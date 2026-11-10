import type pg from "pg";
import { z } from "zod";

const accountSchema = z.object({
  id: z.string(),
  institution: z.string(),
  name: z.string(),
  kind: z.enum(["bank", "card", "investment", "loan"]),
  subtype: z.string().nullable(),
  scope: z.enum(["household", "business", "unknown"]),
  notes: z.string().nullable(),
});
const targetSchema = z.object({
  category: z.string(),
  monthly_min: z.string(),
  monthly_max: z.string(),
  status: z.enum(["draft", "approved"]),
  is_estimate: z.boolean(),
  notes: z.string().nullable(),
});

export async function accounts(db: pg.ClientBase | pg.Pool) {
  const result = await db.query(
    `select id::text, institution, name, kind, subtype, scope, notes
      from accounts order by institution, name, id`,
  );
  return z.array(accountSchema).parse(result.rows);
}

export async function budgetTargets(db: pg.ClientBase | pg.Pool) {
  const result = await db.query(
    `select category, monthly_min::text, monthly_max::text, status, is_estimate, notes
      from budget_targets order by category`,
  );
  return z.array(targetSchema).parse(result.rows);
}
