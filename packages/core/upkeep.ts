import type pg from "pg";
import { z } from "zod";

type Database = pg.ClientBase | pg.Pool;
const dateSchema = z.iso.date().refine((date) => date >= "1900-01-01" && date <= "2200-12-31");
const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("interval"), months: z.number().int().positive() }),
  z.object({ kind: z.literal("yearly"), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) }),
]);
export const upkeepSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.enum(["home", "vehicle"]),
  schedule: scheduleSchema,
  notes: z.string().nullable(),
  last_done_on: z.iso.date().nullable(),
  next_due_on: z.iso.date().nullable(),
  status: z.enum(["no_record", "overdue", "due", "upcoming"]),
});
export const logUpkeepCompletionSchema = z.object({
  request_id: z.uuid(),
  task_id: z
    .string()
    .regex(/^[1-9]\d*$/)
    .refine((id) => BigInt(id) <= 9223372036854775807n),
  completed_on: dateSchema,
  notes: z.string().trim().max(2000).nullish(),
});
const completionSchema = logUpkeepCompletionSchema.extend({ id: z.string(), notes: z.string().nullable() });
const completionColumns = "id::text, request_id::text, task_id::text, completed_on::text, notes";

export async function listUpkeep(db: Database, from: string) {
  dateSchema.parse(from);
  const { rows } = await db.query(
    `with history as (
      select t.*, (select max(completed_on) from upkeep_completions where task_id = t.id
        and completed_on <= $1::date) as last_done_on from upkeep_tasks t
    ), due as (
      select *, case when last_done_on is null then null
        when interval_months is not null then (last_done_on + make_interval(months => interval_months))::date
        else (select (make_date(y + 1, yearly_month, 1)
          + least(yearly_day, extract(day from (make_date(y + 1, yearly_month, 1)
            + interval '1 month - 1 day'))::int) - 1)::date
          from generate_series(extract(year from last_done_on)::int - 1, extract(year from last_done_on)::int + 1) y
          cross join lateral (select (make_date(y, yearly_month, 1)
            + least(yearly_day, extract(day from (make_date(y, yearly_month, 1)
              + interval '1 month - 1 day'))::int) - 1)::date as occurrence) dates
          order by abs(last_done_on - occurrence), occurrence limit 1) end as next_due_on
      from history
    )
    select id::text, name, category, notes,
      case when interval_months is not null then jsonb_build_object('kind', 'interval', 'months', interval_months)
        else jsonb_build_object('kind', 'yearly', 'month', yearly_month, 'day', yearly_day) end as schedule,
      last_done_on::text, next_due_on::text,
      case when last_done_on is null then 'no_record' when next_due_on < $1::date then 'overdue'
        when next_due_on = $1::date then 'due' else 'upcoming' end as status
    from due order by next_due_on nulls last, due.id`,
    [from],
  );
  return z.array(upkeepSchema).parse(rows);
}

export async function upkeepDue(db: Database, from: string, days: number) {
  z.number().int().min(1).max(62).parse(days);
  dateSchema.parse(from);
  const through = new Date(`${from}T12:00:00Z`);
  through.setUTCDate(through.getUTCDate() + days - 1);
  const end = through.toISOString().slice(0, 10);
  return (await listUpkeep(db, from)).filter((task) => task.next_due_on === null || task.next_due_on <= end);
}

export async function logUpkeepCompletion(db: Database, input: z.input<typeof logUpkeepCompletionSchema>) {
  const data = logUpkeepCompletionSchema.parse(input);
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  if (data.completed_on > today) throw new Error("Completion date cannot be in the future");
  const { rows } = await db.query(
    `insert into upkeep_completions (request_id, task_id, completed_on, notes) values ($1, $2, $3, $4)
      on conflict (request_id) do nothing returning ${completionColumns}`,
    [data.request_id, data.task_id, data.completed_on, data.notes ?? null],
  );
  const stored =
    rows[0] ??
    (await db.query(`select ${completionColumns} from upkeep_completions where request_id = $1`, [data.request_id]))
      .rows[0];
  return { completion: completionSchema.parse(stored), already_existed: rows.length === 0 };
}
