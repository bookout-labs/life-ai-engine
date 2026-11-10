import type pg from "pg";
import { z } from "zod";
import { slugSchema } from "./pages.ts";

const text = z.string().trim().min(1);
const statusSchema = z.enum(["active", "done", "dropped"]);
const measureSchema = z.object({
  target: z.string().regex(/^-?\d+(\.\d+)?$/),
  unit: text,
});
export const recordGoalSchema = z.object({
  request_id: z.uuid(),
  area: text.max(80),
  title: text,
  measure: measureSchema.nullish(),
  due_on: z.iso.date().nullish(),
  page_slug: slugSchema,
});
export const setGoalStatusSchema = z.object({
  id: z.string().regex(/^[1-9]\d*$/),
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
  const { rows } = await db.query(`select ${columns} from goals where status = 'active' order by area, id`);
  const grouped = new Map<string, z.infer<typeof goalSchema>[]>();
  for (const goal of z.array(goalSchema).parse(rows)) {
    const goals = grouped.get(goal.area) ?? [];
    goals.push(goal);
    grouped.set(goal.area, goals);
  }
  return Array.from(grouped, ([area, goals]) => ({ area, goals }));
}

export async function recordGoal(db: pg.ClientBase | pg.Pool, input: z.input<typeof recordGoalSchema>) {
  const goal = recordGoalSchema.parse(input);
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
  const { rows } = await db.query(`update goals set status = $2 where id = $1 returning ${columns}`, [id, status]);
  return rows[0] ? goalSchema.parse(rows[0]) : null;
}
