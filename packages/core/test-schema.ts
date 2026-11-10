import { readFile } from "node:fs/promises";

export async function temporarySchema(): Promise<string> {
  const schema = await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8");
  return `${schema
    .replace(/^\\.*$/gm, "")
    .replaceAll("CREATE TABLE public.", "CREATE TEMP TABLE public.")
    .replaceAll("public.", "pg_temp.")}
SET search_path TO public;`;
}
