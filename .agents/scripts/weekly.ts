import { parseArgs } from "node:util";
import type pg from "pg";
import { today } from "../../packages/core/schedule.ts";
import { weekly } from "../../packages/core/weekly.ts";

export async function runWeekly(db: pg.ClientBase | pg.Pool, args: string[]): Promise<string> {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  if (positionals.length > 1) throw new Error("Usage: weekly.ts [from YYYY-MM-DD]");
  const date = new Date(`${today()}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + ((8 - date.getUTCDay()) % 7));
  return JSON.stringify(await weekly(db, positionals[0] ?? date.toISOString().slice(0, 10)), null, 2);
}

if (import.meta.main) {
  const { db } = await import("./db.ts");
  const client = await db.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    const result = await runWeekly(client, process.argv.slice(2));
    await client.query("commit");
    process.stdout.write(`${result}\n`);
  } finally {
    client.release();
    await db.end();
  }
}
