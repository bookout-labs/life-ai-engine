import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

test("schema includes every migration version", async () => {
  const files = await readdir("db/migrations");
  const schema = await readFile("db/schema.sql", "utf8");
  const insert = schema.match(/INSERT INTO public\.schema_migrations \(version\) VALUES\s*([\s\S]*?);/);
  assert.ok(insert, "db/schema.sql is missing its schema_migrations insert");
  const versions = new Set([...(insert[1] ?? "").matchAll(/\('([^']+)'\)/g)].map((match) => match[1]));
  const missing = files.flatMap((file) => {
    const version = file.match(/^(\d+)_.*\.sql$/)?.[1];
    return version && !versions.has(version) ? [version] : [];
  });
  assert.deepEqual(
    missing,
    [],
    `Missing migration versions: ${missing.join(", ")}. Regenerate db/schema.sql with dbmate dump from a disposable database migrated from db/migrations, never production.`,
  );
});
