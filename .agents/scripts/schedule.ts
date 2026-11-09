// Prints the family's events from Neon. `node .agents/scripts/schedule.ts [from YYYY-MM-DD] [days]`, default today and 7.
import { parseArgs } from "node:util";
import { schedule } from "../../packages/core/schedule.ts";
import { db } from "./db.ts";

const { positionals } = parseArgs({ allowPositionals: true });
const [from, days] = positionals;
const rows = await schedule(db, from, days ? Number(days) : undefined);
await db.end();

for (const r of rows) console.log([r.day, r.time, r.who, r.what, r.location].filter(Boolean).join(" | "));
if (rows.length === 0) console.log("No events in that window.");
