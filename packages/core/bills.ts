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

// A charge already recorded for that day wins; otherwise the latest charge is what to expect.
export async function billsDue(db: pg.ClientBase | pg.Pool, from: string, days: number): Promise<Bill[]> {
  const { rows } = await db.query<Bill>(
    `select to_char(d.day, 'Dy Mon DD') as day, o.name, o.pays_from, o.day_is_estimate,
            coalesce(exact.amount, last.amount)::text as amount,
            coalesce(exact.amount_is_estimate, last.amount_is_estimate, false) as amount_is_estimate
       from generate_series($1::date, $1::date + $2::int - 1, interval '1 day') as d(day)
       join obligations o
         on o.ended_on is null and o.due_day is not null
        and (o.cadence = 'monthly' or o.due_month = extract(month from d.day))
        -- A due day past the month's end (the 31st in November) falls on its last day.
        and extract(day from d.day) = least(o.due_day, extract(day from date_trunc('month', d.day) + interval '1 month - 1 day'))
       left join charges exact on exact.obligation_id = o.id and exact.due_on = d.day::date
       left join lateral (
         select amount, amount_is_estimate from charges
          where obligation_id = o.id and due_on < d.day::date
          order by due_on desc limit 1
       ) last on true
      where exact.paid_on is null
      order by d.day, o.name`,
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
