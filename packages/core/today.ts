import type pg from "pg";
import { z } from "zod";
import { billsDue, deadlinesDue } from "./bills.ts";
import { MONEY_CHECK_DAYS, moneyCheckSchema, readMoneyCheck } from "./money-check.ts";
import { pageList, slugSchema } from "./pages.ts";
import { schedule, today } from "./schedule.ts";
import { upkeepDue, upkeepSchema } from "./upkeep.ts";

const pageSchema = z.object({ slug: slugSchema, type: z.string(), body: z.string() });
const membersSchema = z.array(z.object({ name: z.string(), species: z.string(), born: z.iso.date().nullable() }));
const fixtureSchema = z.object({
  now: z.iso.datetime({ offset: true }),
  members: membersSchema,
  events: z.array(
    z.object({ day: z.string(), time: z.string(), who: z.string(), what: z.string(), location: z.string().nullable() }),
  ),
  bills: z.array(
    z.object({
      day: z.string(),
      name: z.string(),
      amount: z.string().nullable(),
      amount_is_estimate: z.boolean(),
      day_is_estimate: z.boolean(),
      pays_from: z.string().nullable(),
    }),
  ),
  deadlines: z.array(z.object({ due_on: z.string(), item: z.string(), action: z.string(), overdue: z.boolean() })),
  pages: z.array(pageSchema),
  upkeep: z.array(upkeepSchema).optional(),
  money_check: moneyCheckSchema.omit({ due_soon: true }).optional(),
});
const windows = { events: 7, bills: MONEY_CHECK_DAYS, deadlines: 14 };

export function buildToday(input: unknown) {
  const data = fixtureSchema.parse(input);
  const date = today(new Date(data.now));
  const dailySlug = `daily/${date}`;
  const pages = data.pages.toSorted((a, b) => a.slug.localeCompare(b.slug));
  const daily = pages.filter((p) => p.type === "daily" && /^daily\/\d{4}-\d{2}-\d{2}$/.test(p.slug));
  return {
    date,
    dailySlug,
    windows,
    members: data.members,
    events: data.events,
    bills: data.bills,
    ...(data.money_check ? { money_check: data.money_check } : {}),
    deadlines: data.deadlines,
    ...(data.upkeep ? { upkeep: data.upkeep } : {}),
    context: pages.filter((p) => ["person", "area", "project"].includes(p.type)),
    previousDaily: daily.filter((p) => p.slug < dailySlug).at(-1) ?? null,
    currentDaily: daily.find((p) => p.slug === dailySlug) ?? null,
  };
}

export async function readToday(db: pg.ClientBase, now = new Date().toISOString()) {
  z.iso.datetime({ offset: true }).parse(now);
  const date = today(new Date(now));
  await db.query("begin isolation level repeatable read read only");
  try {
    const members = await db.query(
      "select coalesce(goes_by, first_name) as name, species, born::text from members order by id",
    );
    const bills = await billsDue(db, date, windows.bills);
    const result = buildToday({
      now,
      members: members.rows,
      events: await schedule(db, date, windows.events),
      bills,
      upkeep: await upkeepDue(db, date, 7),
      money_check: await readMoneyCheck(db, date, bills),
      deadlines: await deadlinesDue(db, date, windows.deadlines),
      pages: await pageList(db),
    });
    await db.query("commit");
    return result;
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}
