// Bills and deadlines coming due, shared by the local script and the Worker so the query lives in one place.
import type pg from "pg";

export type Bill = {
  day: string;
  name: string;
  amount: string | null;
  amount_is_estimate: boolean;
  day_is_estimate: boolean;
  pays_from: string | null;
};
export type Deadline = { due_on: string; item: string; action: string; overdue: boolean };

// Each recorded charge claims its nearest scheduled date; only unclaimed dates are projected.
export async function billsDue(db: pg.ClientBase | pg.Pool, from: string, days: number): Promise<Bill[]> {
  const { rows } = await db.query<Bill>(
    `with recorded as (
       select c.*, nearest.day as scheduled_on
         from charges c join obligations o on o.id = c.obligation_id
         cross join lateral (
           select scheduled.day
             from generate_series(-1, 1) as candidate(n)
             cross join lateral (
               select case o.cadence
                 when 'monthly' then date_trunc('month', c.due_on) + candidate.n * interval '1 month'
                 else date_trunc('year', c.due_on) + candidate.n * interval '1 year'
                   + (o.due_month - 1) * interval '1 month'
               end as start
             ) month
             cross join lateral (
               select month.start::date + least(o.due_day,
                 extract(day from month.start + interval '1 month - 1 day')::int) - 1 as day
             ) scheduled
            -- A midpoint charge claims the upcoming bill rather than the previous one.
            order by abs(scheduled.day - c.due_on), scheduled.day desc limit 1
         ) nearest
        where o.due_day is not null
     ), bills as (
       select c.due_on as day, o.name, o.pays_from, o.day_is_estimate, c.amount, c.amount_is_estimate
         from obligations o join recorded c on c.obligation_id = o.id
        where c.paid_on is null and c.due_on >= $1::date and c.due_on < $1::date + $2::int
       union all
       select d.day::date, o.name, o.pays_from, o.day_is_estimate,
              last.amount, coalesce(last.amount_is_estimate, false)
         from generate_series($1::date, $1::date + $2::int - 1, interval '1 day') as d(day)
         join obligations o
           on o.ended_on is null and o.due_day is not null
          and (o.cadence = 'monthly' or o.due_month = extract(month from d.day))
          -- A due day past the month's end falls on its last day.
          and extract(day from d.day) = least(o.due_day, extract(day from date_trunc('month', d.day) + interval '1 month - 1 day'))
         left join lateral (
           select amount, amount_is_estimate from charges
            where obligation_id = o.id and due_on < d.day::date
            order by due_on desc limit 1
         ) last on true
        where not exists (
          select 1 from recorded c
           where c.obligation_id = o.id and c.scheduled_on = d.day::date
        )
     )
     select to_char(day, 'Dy Mon DD') as day, name, pays_from, day_is_estimate,
            amount::text, amount_is_estimate
       from bills order by bills.day, name`,
    [from, days],
  );
  return rows;
}

// Overdue deadlines stay on the list until someone marks them done.
export async function deadlinesDue(db: pg.ClientBase | pg.Pool, from: string, days: number): Promise<Deadline[]> {
  const { rows } = await db.query<Deadline>(
    `select to_char(due_on, 'Dy Mon DD') || case when due_is_estimate then ' (about)' else '' end as due_on,
            item, action, due_on < $1::date as overdue
       from deadlines
      where done_on is null and due_on < $1::date + $2::int
      order by deadlines.due_on`,
    [from, days],
  );
  return rows;
}
