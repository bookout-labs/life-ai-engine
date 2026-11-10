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

// Charges and scheduled dates can each belong to only one matched pair.
export async function billsDue(db: pg.ClientBase | pg.Pool, from: string, days: number): Promise<Bill[]> {
  type Pair = { charge: number; obligation: number; day: string; distance: number };
  const { rows: pairs } = await db.query<Pair>(
    `select c.id as charge, o.id as obligation, to_char(scheduled.day, 'YYYY-MM-DD') as day, abs(scheduled.day - c.due_on) as distance
       from obligations o join charges c on c.obligation_id = o.id
       cross join lateral (
         select day, lag(day) over (order by day) as previous, lead(day) over (order by day) as next
           from (
             select month.start::date + least(o.due_day,
               extract(day from month.start + interval '1 month - 1 day')::int) - 1 as day
               from generate_series(-2, 2) as candidate(n)
               cross join lateral (
                 select case o.cadence
                   when 'monthly' then date_trunc('month', c.due_on) + candidate.n * interval '1 month'
                   else date_trunc('year', c.due_on) + candidate.n * interval '1 year'
                     + (o.due_month - 1) * interval '1 month'
                 end as start
               ) month
           ) dates
       ) scheduled
      where o.due_day is not null
        and c.due_on >= $1::date - interval '1 year'
        and c.due_on < $1::date + $2::int + interval '1 year'
        and scheduled.previous is not null and scheduled.next is not null
        and 2 * abs(scheduled.day - c.due_on) <= case when c.due_on < scheduled.day
          then scheduled.day - scheduled.previous else scheduled.next - scheduled.day end
      order by o.id, c.due_on, c.id, scheduled.day`,
    [from, days],
  );
  type Match = { cost: number; days: string[] };
  const better = (a: Match, b: Match): Match => {
    if (a.days.length !== b.days.length) return a.days.length > b.days.length ? a : b;
    if (a.cost !== b.cost) return a.cost < b.cost ? a : b;
    for (let i = 0; i < a.days.length; i++) {
      const left = a.days[i];
      const right = b.days[i];
      if (left !== undefined && right !== undefined && left !== right) return left < right ? a : b;
    }
    return a;
  };
  const empty: Match = { cost: 0, days: [] };
  const obligations = new Map<number, Map<number, Pair[]>>();
  for (const pair of pairs) {
    let charges = obligations.get(pair.obligation);
    if (!charges) {
      charges = new Map();
      obligations.set(pair.obligation, charges);
    }
    const eligible = charges.get(pair.charge);
    if (eligible) eligible.push(pair);
    else charges.set(pair.charge, [pair]);
  }
  const claimed: { obligation: number; day: string }[] = [];
  for (const [obligation, charges] of obligations) {
    const dates = [...new Set([...charges.values()].flat().map((pair) => pair.day))].sort();
    let previous: Match[] = Array.from({ length: dates.length + 1 }, () => ({ cost: 0, days: [] }));
    // Absolute distance on a line admits a non-crossing optimum. Each cell covers two sorted prefixes.
    for (const eligible of charges.values()) {
      const current: Match[] = [{ cost: 0, days: [] }];
      for (let j = 0; j < dates.length; j++) {
        let best = better(previous[j + 1] ?? empty, current[j] ?? empty);
        const pair = eligible.find((pair) => pair.day === dates[j]);
        if (pair) {
          const prefix = previous[j] ?? empty;
          best = better(best, { cost: prefix.cost + pair.distance, days: [...prefix.days, pair.day] });
        }
        current.push(best);
      }
      previous = current;
    }
    for (const day of (previous[dates.length] ?? empty).days) claimed.push({ obligation, day });
  }
  const { rows } = await db.query<Bill>(
    `with recorded as (
       select c.* from charges c join obligations o on o.id = c.obligation_id
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
          select 1 from unnest($3::int[], $4::date[]) as claimed(obligation, day)
           where claimed.obligation = o.id and claimed.day = d.day::date
        )
     )
     select to_char(day, 'Dy Mon DD') as day, name, pays_from, day_is_estimate,
            amount::text, amount_is_estimate
       from bills order by bills.day, name`,
    [from, days, claimed.map((pair) => pair.obligation), claimed.map((pair) => pair.day)],
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
