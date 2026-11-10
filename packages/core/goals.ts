import pg from "pg";
import { z } from "zod";
import { slugSchema } from "./pages.ts";

const text = z.string().trim().min(1);
const statusSchema = z.enum(["active", "done", "dropped"]);
const measureSchema = z.object({
  target: z.string().regex(/^-?\d+(\.\d+)?$/),
  unit: text.max(40),
});
export const recordGoalSchema = z.object({
  request_id: z.uuid(),
  area: text.max(80).toLowerCase(),
  title: text.max(200),
  measure: measureSchema.nullish(),
  due_on: z.iso
    .date()
    .refine((date) => date >= "1900-01-01" && date <= "2200-12-31")
    .nullish(),
  page_slug: slugSchema,
});
export const setGoalStatusSchema = z.object({
  id: z
    .string()
    .max(19)
    .regex(/^[1-9]\d*$/),
  status: statusSchema,
});
const goalSchema = recordGoalSchema.extend({
  id: z.string(),
  status: statusSchema,
  measure: measureSchema.nullable(),
  due_on: z.iso.date().nullable(),
});
const columns = `id::text, request_id::text, area, title, status, due_on::text, page_slug,
  case when target is null then null else jsonb_build_object('target', target::text, 'unit', unit) end as measure`;

export async function activeGoals(db: pg.ClientBase | pg.Pool) {
  const { rows } = await db.query(
    `select ${columns}, exists (select 1 from pages where pages.slug = goals.page_slug and deleted_at is not null) as page_deleted from goals where status = 'active' order by area, goals.id`,
  );
  const activeGoalSchema = goalSchema.extend({ page_deleted: z.boolean() });
  const grouped = new Map<string, z.infer<typeof activeGoalSchema>[]>();
  for (const goal of z.array(activeGoalSchema).parse(rows)) {
    const goals = grouped.get(goal.area) ?? [];
    goals.push(goal);
    grouped.set(goal.area, goals);
  }
  return Array.from(grouped, ([area, goals]) => ({ area, goals }));
}

export async function recordGoal(db: pg.ClientBase | pg.Pool, input: z.input<typeof recordGoalSchema>) {
  const goal = recordGoalSchema.parse(input);
  const page = await db.query("select deleted_at from pages where slug = $1", [goal.page_slug]);
  if (page.rows[0]?.deleted_at) {
    const error = new pg.DatabaseError("Cannot link a goal to a deleted page", 0, "error");
    error.code = "23514";
    error.constraint = "page is deleted";
    throw error;
  }
  const { rows } = await db.query(
    `insert into goals (request_id, area, title, target, unit, due_on, page_slug)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (request_id) do nothing returning ${columns}`,
    [
      goal.request_id,
      goal.area,
      goal.title,
      goal.measure?.target ?? null,
      goal.measure?.unit ?? null,
      goal.due_on ?? null,
      goal.page_slug,
    ],
  );
  const stored =
    rows[0] ?? (await db.query(`select ${columns} from goals where request_id = $1`, [goal.request_id])).rows[0];
  return { goal: goalSchema.parse(stored), already_existed: rows.length === 0 };
}

export async function setGoalStatus(db: pg.ClientBase | pg.Pool, input: z.input<typeof setGoalStatusSchema>) {
  const { id, status } = setGoalStatusSchema.parse(input);
  if (BigInt(id) > 9223372036854775807n) return null;
  const { rows } = await db.query(`update goals set status = $2 where id = $1 returning ${columns}`, [id, status]);
  return rows[0] ? goalSchema.parse(rows[0]) : null;
}
