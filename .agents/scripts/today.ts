import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { buildToday, readToday } from "../../packages/core/today.ts";

export async function runToday(args: string[], read = (path: string) => readFile(path, "utf8")): Promise<string> {
  const { values } = parseArgs({
    args,
    options: { fixture: { type: "string" }, now: { type: "string" } },
  });
  if (values.fixture) {
    if (values.now) throw new Error("Set now inside the fixture, not with --now");
    return JSON.stringify(buildToday(JSON.parse(await read(values.fixture))), null, 2);
  }
  const { db } = await import("./db.ts");
  try {
    const client = await db.connect();
    try {
      return JSON.stringify(await readToday(client, values.now), null, 2);
    } finally {
      client.release();
    }
  } finally {
    await db.end();
  }
}

if (import.meta.main) process.stdout.write(`${await runToday(process.argv.slice(2))}\n`);
