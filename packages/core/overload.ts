import type pg from "pg";
import { z } from "zod";

const TIME_ZONE = "America/Chicago";
const EVENING_START_HOUR = 17;
const EVENING_END_HOUR = 21;
const OVERLOAD_THRESHOLD = 4;
const WEEKS = 3;

export async function overloadWeeks(db: pg.ClientBase | pg.Pool, from: string) {
  z.iso.date().parse(from);
  const { rows } = await db.query(
    `with bounds as (
       select date_trunc('week', $1::date::timestamp)::date as first_day
     ), days as (
       select first_day + n as day from bounds, generate_series(0, $2::int * 7 - 1) n
     )
     select day::text as day, exists (
       select 1 from events e where not e.cancelled
         and e.starts_at < (day + make_interval(hours => $4::int)) at time zone $5
         and coalesce(e.ends_at, e.starts_at + interval '1 hour') > (day + make_interval(hours => $3::int)) at time zone $5
     ) as booked from days order by day`,
    [from, WEEKS, EVENING_START_HOUR, EVENING_END_HOUR, TIME_ZONE],
  );
  const days = z.array(z.object({ day: z.iso.date(), booked: z.boolean() })).parse(rows);
  return Array.from({ length: WEEKS }, (_, i) => {
    const week = days.slice(i * 7, i * 7 + 7);
    const bookedDates = week.filter((day) => day.booked).map((day) => day.day);
    return {
      weekStart: z.object({ day: z.iso.date() }).parse(week[0]).day,
      bookedEveningCount: bookedDates.length,
      bookedDates,
      overloaded: bookedDates.length >= OVERLOAD_THRESHOLD,
    };
  });
}
