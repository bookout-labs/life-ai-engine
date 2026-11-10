import pg from "pg";
import { z } from "zod";
import { InputError } from "./input-error.ts";

type Database = pg.ClientBase | pg.Pool;
const id = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
const date = z.iso.date().refine((v) => v >= "1900-01-01" && v <= "2200-12-31");
const fields = z.object({
  activity_id: id,
  weekday: z.number().int().min(1).max(7),
  local_start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  duration_minutes: z.number().int().min(1).max(1440),
  kind: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((v) => v === v.toLowerCase() && v !== "cancelled"),
  location: z.string().max(2000).nullable().default(null),
  active_from: date,
  active_until: date,
});
const pattern = fields.extend({ id });
export const recordWeeklyPatternSchema = z.object({
  request_id: z.uuid(),
  command: z.discriminatedUnion("action", [
    fields.extend({ action: z.literal("record") }),
    z.object({ action: z.literal("end"), pattern_id: id, active_until: date }),
  ]),
});
export const previewWeeklySessionsSchema = z.object({ week_start: date });
export const addWeeklySessionsSchema = z.object({
  request_id: z.uuid(),
  week_start: date,
  skipped: z
    .array(z.object({ pattern_id: id, local_date: date }))
    .max(1000)
    .default([]),
});
const occurrence = z.object({
  pattern_id: id,
  activity_id: id,
  local_date: date,
  starts_at: z.string(),
  ends_at: z.string(),
  kind: z.string(),
  location: z.string().nullable(),
  status: z.enum(["pending", "created", "skipped"]),
  event_id: id.nullable(),
});
const patternResult = z.object({ pattern });
const weekResult = z.object({
  week_start: date,
  created: z.number().int(),
  adopted: z.number().int(),
  skipped: z.number().int(),
});
const patternColumns = `id::text, activity_id::text, weekday, to_char(local_start, 'HH24:MI') as local_start,
  duration_minutes, kind, location, active_from::text, active_until::text`;

async function write(
  db: Database,
  requestId: string,
  operation: "pattern" | "week",
  use: (client: Database) => Promise<object>,
  requestKey?: string,
) {
  const pooled = db instanceof pg.Pool ? await db.connect() : undefined;
  const client = pooled ?? db;
  try {
    await client.query("begin");
    // Serialize pattern changes and overlapping week writes before reading the occurrence ledger.
    await client.query("lock table weekly_patterns in share row exclusive mode");
    const prior = await client.query("select operation, result from weekly_requests where request_id = $1", [
      requestId,
    ]);
    if (prior.rows.length) {
      if (prior.rows[0].operation !== operation)
        throw new InputError("Request ID already used for a different operation.");
      if (requestKey !== undefined && prior.rows[0].result.request_key !== requestKey)
        throw new InputError("Request ID already used for different weekly session input.");
      await client.query("commit");
      return { result: prior.rows[0].result, already_existed: true };
    }
    const result = await use(client);
    await client.query("insert into weekly_requests (request_id, operation, result) values ($1, $2, $3)", [
      requestId,
      operation,
      requestKey === undefined ? result : { ...result, request_key: requestKey },
    ]);
    await client.query("commit");
    return { result, already_existed: false };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    pooled?.release();
  }
}

function monday(week: string) {
  if (new Date(`${week}T12:00:00Z`).getUTCDay() !== 1) throw new InputError("Week start must be a Monday.");
}

export async function recordWeeklyPattern(db: Database, input: unknown) {
  const value = recordWeeklyPatternSchema.parse(input);
  const saved = await write(db, value.request_id, "pattern", async (client) => {
    const command = value.command;
    if (command.action === "end") {
      const existing = await client.query(`select ${patternColumns} from weekly_patterns where id = $1`, [
        command.pattern_id,
      ]);
      if (!existing.rows.length) throw new InputError(`Pattern ${command.pattern_id} not found.`);
      const current = pattern.parse(existing.rows[0]);
      if (command.active_until < current.active_from || command.active_until > current.active_until)
        throw new InputError("Pattern end must be within its current window.");
      const updated = await client.query(
        `update weekly_patterns set active_until = $2 where id = $1 returning ${patternColumns}`,
        [command.pattern_id, command.active_until],
      );
      return { pattern: pattern.parse(updated.rows[0]) };
    }
    const activity = await client.query(
      "select season_start::text, season_end::text from activities where id = $1 for share",
      [command.activity_id],
    );
    if (!activity.rows.length) throw new InputError(`Activity ${command.activity_id} not found.`);
    const season = z.object({ season_start: z.string(), season_end: z.string().nullable() }).parse(activity.rows[0]);
    if (command.active_until < command.active_from) throw new InputError("Pattern end must be on or after its start.");
    if (
      command.active_from < season.season_start ||
      (season.season_end !== null && command.active_until > season.season_end)
    )
      throw new InputError("Pattern dates must be within the activity season.");
    const overlap = await client.query(
      `select id::text from weekly_patterns
       where activity_id = $1 and weekday = $2 and local_start = $3::time
         and active_from <= $5::date and active_until >= $4::date
       order by weekly_patterns.id limit 1`,
      [command.activity_id, command.weekday, command.local_start, command.active_from, command.active_until],
    );
    if (overlap.rows.length) throw new InputError(`Pattern overlaps existing pattern ${overlap.rows[0].id}.`);
    const inserted = await client.query(
      `insert into weekly_patterns (activity_id, weekday, local_start, duration_minutes, kind, location, active_from, active_until)
      values ($1,$2,$3,$4,$5,$6,$7,$8) returning ${patternColumns}`,
      [
        command.activity_id,
        command.weekday,
        command.local_start,
        command.duration_minutes,
        command.kind,
        command.location,
        command.active_from,
        command.active_until,
      ],
    );
    return { pattern: pattern.parse(inserted.rows[0]) };
  });
  return { ...patternResult.parse(saved.result), already_existed: saved.already_existed };
}

export async function previewWeeklySessions(db: Database, input: unknown) {
  const value = previewWeeklySessionsSchema.parse(input);
  monday(value.week_start);
  const { rows } = await db.query(
    `with dates as (
    select ($1::date + n)::date as local_date from generate_series(0, 6) n
  ), sessions as (
    select p.*, d.local_date, (d.local_date + p.local_start) at time zone 'America/Chicago' as starts_at
    from weekly_patterns p join activities a on a.id = p.activity_id
    join dates d on extract(isodow from d.local_date) = p.weekday
    where d.local_date between p.active_from and p.active_until
      and d.local_date >= a.season_start and (a.season_end is null or d.local_date <= a.season_end)
  ) select s.id::text as pattern_id, s.activity_id::text, s.local_date::text,
    to_char(s.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as starts_at,
    to_char((s.starts_at + make_interval(mins => s.duration_minutes)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ends_at,
    s.kind, s.location, coalesce(o.status, case when e.cancelled then 'skipped' when e.id is not null then 'created' else 'pending' end) as status, coalesce(o.event_id, e.id)::text as event_id
    from sessions s left join weekly_occurrences o on o.pattern_id = s.id and o.local_date = s.local_date
    left join events e on e.activity_id = s.activity_id and e.starts_at = s.starts_at
    order by s.local_date, s.id`,
    [value.week_start],
  );
  return z.array(occurrence).parse(rows);
}

export async function addWeeklySessions(db: Database, input: unknown) {
  const value = addWeeklySessionsSchema.parse(input);
  monday(value.week_start);
  const requestKey = JSON.stringify([
    value.week_start,
    [...new Set(value.skipped.map((s) => `${s.pattern_id}/${s.local_date}`))].sort(),
  ]);
  const saved = await write(
    db,
    value.request_id,
    "week",
    async (client) => {
      const sessions = await previewWeeklySessions(client, value);
      for (const skip of value.skipped) {
        if (!(await client.query("select id from weekly_patterns where id = $1", [skip.pattern_id])).rows.length)
          throw new InputError(`Pattern ${skip.pattern_id} not found.`);
        if (!sessions.some((s) => s.pattern_id === skip.pattern_id && s.local_date === skip.local_date))
          throw new InputError(
            "Skipped date must be an occurrence in this week within the pattern window and activity season.",
          );
      }
      let created = 0;
      let adopted = 0;
      let skipped = 0;
      for (const session of sessions) {
        if (value.skipped.some((s) => s.pattern_id === session.pattern_id && s.local_date === session.local_date)) {
          await client.query(
            `insert into weekly_occurrences (pattern_id, local_date, event_id, status) values ($1,$2,$3,'skipped')
          on conflict (pattern_id, local_date) do update set status = 'skipped'`,
            [session.pattern_id, session.local_date, session.event_id],
          );
          if (session.event_id)
            await client.query("update events set cancelled = true where id = $1", [session.event_id]);
          skipped++;
        } else if (
          !(
            await client.query("select 1 from weekly_occurrences where pattern_id = $1 and local_date = $2", [
              session.pattern_id,
              session.local_date,
            ])
          ).rows.length
        ) {
          const event = await client.query(
            `insert into events (activity_id, kind, starts_at, ends_at, location)
          values ($1,$2,$3,$4,$5) on conflict (activity_id, starts_at) do nothing returning id::text, cancelled`,
            [session.activity_id, session.kind, session.starts_at, session.ends_at, session.location],
          );
          const inserted = event.rows.length > 0;
          const existing = inserted
            ? event
            : await client.query(
                "select id::text, cancelled from events where activity_id = $1 and starts_at = $2 for update",
                [session.activity_id, session.starts_at],
              );
          const savedEvent = z.object({ id, cancelled: z.boolean() }).parse(existing.rows[0]);
          await client.query(
            "insert into weekly_occurrences (pattern_id, local_date, event_id, status) values ($1,$2,$3,$4)",
            [session.pattern_id, session.local_date, savedEvent.id, savedEvent.cancelled ? "skipped" : "created"],
          );
          if (savedEvent.cancelled) skipped++;
          else if (inserted) created++;
          else adopted++;
        }
      }
      return { week_start: value.week_start, created, adopted, skipped };
    },
    requestKey,
  );
  return { ...weekResult.parse(saved.result), already_existed: saved.already_existed };
}
