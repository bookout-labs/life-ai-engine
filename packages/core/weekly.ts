import type pg from "pg";
import { z } from "zod";
import { billsDue, deadlinesDue } from "./bills.ts";
import { overloadWeeks } from "./overload.ts";
import { addDays, schedule } from "./schedule.ts";
import { upkeepDue } from "./upkeep.ts";

export function weeklyWindow(from: string) {
  z.iso.date().parse(from);
  const offset = (days: number) => addDays(from, days);
  return { from, through: offset(6), deadlinesThrough: offset(13), timeZone: "America/Chicago" };
}

const memberSchema = z.object({ id: z.string(), name: z.string(), species: z.string() });
const relationshipSchema = z.object({
  member_id: z.string(),
  related_id: z.string(),
  kind: z.enum(["parent", "spouse"]),
});
const activitySchema = z.object({
  id: z.string(),
  member_id: z.string(),
  activity: z.string(),
  season_start: z.string(),
  season_end: z.string().nullable(),
});
const loanSchema = z.object({
  obligation_id: z.string(),
  name: z.string(),
  lender: z.string(),
  apr_percent: z.string().nullable(),
  balance: z.string().nullable(),
  balance_as_of: z.string().nullable(),
});
const undatedSchema = z.object({ item: z.string(), action: z.string() });
const unscheduledSchema = z.object({ name: z.string(), kind: z.string() });

export async function weekly(db: pg.ClientBase | pg.Pool, from: string) {
  const window = weeklyWindow(from);
  const bills = await billsDue(db, from, 7);
  const deadlines = await deadlinesDue(db, from, 14);
  const events = await schedule(db, from, 7);
  const members = await db.query(
    "select id::text, coalesce(goes_by, first_name) as name, species from members order by members.id",
  );
  const relationships = await db.query(
    "select member_id::text, related_id::text, kind from relationships order by relationships.member_id, relationships.related_id, kind",
  );
  const activities = await db.query(
    `select id::text, member_id::text, activity, season_start::text, season_end::text
      from activities where season_start < $1::date + 7 and (season_end is null or season_end >= $1::date)
      order by activities.member_id, activities.season_start, activities.id`,
    [from],
  );
  const loans = await db.query(
    `select l.obligation_id::text, o.name, l.lender, l.apr_percent::text,
        b.balance::text, b.as_of::text as balance_as_of
      from loans l join obligations o on o.id = l.obligation_id
      left join lateral (select balance, as_of from loan_balances where obligation_id = l.obligation_id
        and as_of <= $1::date order by as_of desc limit 1) b on true
      where o.ended_on is null order by o.name`,
    [from],
  );
  const undatedDeadlines = await db.query(
    "select item, action from deadlines where done_on is null and due_on is null order by id",
  );
  const unscheduledObligations = await db.query(
    "select name, kind from obligations where ended_on is null and due_day is null order by name",
  );
  return {
    window,
    overloadWeeks: await overloadWeeks(db, from),
    bills,
    deadlines,
    upkeep: await upkeepDue(db, from, 7),
    events,
    members: z.array(memberSchema).parse(members.rows),
    relationships: z.array(relationshipSchema).parse(relationships.rows),
    activities: z.array(activitySchema).parse(activities.rows),
    loans: z.array(loanSchema).parse(loans.rows),
    undatedDeadlines: z.array(undatedSchema).parse(undatedDeadlines.rows),
    unscheduledObligations: z.array(unscheduledSchema).parse(unscheduledObligations.rows),
    unavailable: ["spending and budget actuals", "workout logs", "investment execution history"],
  };
}
