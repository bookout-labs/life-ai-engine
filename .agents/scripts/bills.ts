// Prints bills and deadlines from Neon. `node .agents/scripts/bills.ts [from YYYY-MM-DD] [bill days] [deadline days]`, default today, 7, 14.
import { parseArgs } from "node:util";
import { billsDue, deadlinesDue } from "../../packages/core/bills.ts";
import { today } from "../../packages/core/schedule.ts";
import { db } from "./db.ts";

const { positionals } = parseArgs({ allowPositionals: true });
const from = positionals[0] ?? today();
const billDays = Number(positionals[1] ?? 7);
const deadlineDays = Number(positionals[2] ?? 14);

const [bills, deadlines] = await Promise.all([billsDue(db, from, billDays), deadlinesDue(db, from, deadlineDays)]);
await db.end();

const money = (b: (typeof bills)[number]): string =>
  b.amount === null ? "amount unknown" : `${b.amount_is_estimate ? "~" : ""}$${b.amount}`;
console.log(`Bills, ${billDays} days from ${from}:`);
for (const b of bills) {
  console.log(
    `  ${b.day}${b.day_is_estimate ? " (about)" : ""} | ${b.name} | ${money(b)}${b.pays_from ? ` | ${b.pays_from}` : ""}`,
  );
}
if (bills.length === 0) console.log("  none");
console.log(`Deadlines, ${deadlineDays} days:`);
for (const d of deadlines) console.log(`  ${d.overdue ? "OVERDUE " : ""}${d.due_on} | ${d.item} | ${d.action}`);
if (deadlines.length === 0) console.log("  none");
