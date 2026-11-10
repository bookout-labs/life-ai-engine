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

// Recorded charges own their calendar cycle; only cycles without charges are projected.
export async function billsDue(db: pg.ClientBase | pg.Pool, from: string, days: number): Promise<Bill[]> {
  const { rows } = await db.query<Bill>(
    `with active as (
       select * from obligations where ended_on is null and due_day is not null
     ), bills as (
       select c.due_on as day, o.name, o.pays_from, o.day_is_estimate, c.amount, c.amount_is_estimate
         from active o join charges c on c.obligation_id = o.id
        where c.paid_on is null and c.due_on >= $1::date and c.due_on < $1::date + $2::int
       union all
       select d.day::date, o.name, o.pays_from, o.day_is_estimate,
              last.amount, coalesce(last.amount_is_estimate, false)
         from generate_series($1::date, $1::date + $2::int - 1, interval '1 day') as d(day)
         join active o
           on (o.cadence = 'monthly' or o.due_month = extract(month from d.day))
          -- A due day past the month's end (the 31st in November) falls on its last day.
          and extract(day from d.day) = least(o.due_day, extract(day from date_trunc('month', d.day) + interval '1 month - 1 day'))
         left join lateral (
           select amount, amount_is_estimate from charges
            where obligation_id = o.id and due_on < d.day::date
            order by due_on desc limit 1
         ) last on true
        where not exists (
          select 1 from charges c
           where c.obligation_id = o.id
             and date_trunc(case o.cadence when 'monthly' then 'month' else 'year' end, c.due_on)
               = date_trunc(case o.cadence when 'monthly' then 'month' else 'year' end, d.day)
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
