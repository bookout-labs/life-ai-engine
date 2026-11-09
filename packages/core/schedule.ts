// The family's events from Neon, shared by the local script and the Worker so the query lives in one place.
import type pg from "pg";

const TZ = "America/Chicago";

export type Event = { day: string; time: string; who: string; what: string; location: string | null };

export function today(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

export async function schedule(db: pg.ClientBase | pg.Pool, from: string = today(), days = 7): Promise<Event[]> {
  // Cancelled rows stay in the table so nobody refills the gap, but never show as plans.
  const { rows } = await db.query<Event>(
    `select to_char(e.starts_at at time zone $3, 'Dy Mon DD') as day,
            to_char(e.starts_at at time zone $3, 'FMHH12:MI am')
              || coalesce('–' || to_char(e.ends_at at time zone $3, 'FMHH12:MI am'), '') as time,
            coalesce(m.goes_by, m.first_name) as who,
            a.activity || ' ' || e.kind as what,
            e.location
       from events e
       join activities a on a.id = e.activity_id
       join members m on m.id = a.member_id
      where not e.cancelled
        and e.starts_at >= ($1::date)::timestamp at time zone $3
        and e.starts_at < ($1::date + $2::int)::timestamp at time zone $3
      order by e.starts_at, who`,
    [from, days, TZ],
  );
  return rows;
}
