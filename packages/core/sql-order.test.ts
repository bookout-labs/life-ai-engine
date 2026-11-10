import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

function queries(source: string) {
  const literals = [
    ...source.matchAll(
      /\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'/g,
    ),
  ].filter((match) => !match[0].startsWith("/"));
  const constants = new Map<string, string>();
  for (const literal of literals) {
    const declaration = source.slice(0, literal.index).match(/\bconst\s+(\w+)\s*=\s*$/);
    if (declaration?.[1]) constants.set(declaration[1], literal[0].slice(1, -1));
  }
  return literals.flatMap((literal) => {
    const sql = literal[0].slice(1, -1).replace(/\$\{(\w+)\}/g, (_, name: string) => constants.get(name) ?? "?");
    return /\bselect\b[\s\S]*\border\s+by\b/i.test(sql)
      ? [{ sql, line: source.slice(0, literal.index).split("\n").length }]
      : [];
  });
}

function textOrders(sql: string) {
  const tokens =
    sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ").match(/'(?:''|[^'])*'|"(?:""|[^"])*"|[a-z_][a-z_0-9]*|::|[^\s]/gi) ??
    [];
  let depth = 0;
  const parts = tokens.map((token) => {
    if (token === ")") depth--;
    const part = { word: token.toLowerCase(), depth };
    if (token === "(") depth++;
    return part;
  });
  const failures: string[] = [];
  for (const [i, part] of parts.entries()) {
    if (part.word !== "select") continue;
    const end = parts.findIndex(
      (p, j) => j > i && (p.depth < part.depth || (p.depth === part.depth && p.word === "union")),
    );
    const scope = parts.slice(i + 1, end < 0 ? undefined : end).filter((p) => p.depth === part.depth);
    const from = scope.findIndex((p) => p.word === "from");
    if (from < 0) continue;
    const projection = scope
      .slice(0, from)
      .map((p) => p.word)
      .join(" ");
    const outputs = new Set(
      [
        ...projection.matchAll(
          /(?:^|, )(?:distinct )?(?:(?:\w+|"[^"]+") \. )?(\w+|"[^"]+") :: text(?: (?:as )?(\w+|"[^"]+"))?(?= ,|$)/g,
        ),
      ].map((m) => (m[2] ?? m[1] ?? "").replaceAll('"', "")),
    );
    const order = scope.findIndex((p, j) => p.word === "order" && scope[j + 1]?.word === "by");
    if (order < 0) continue;
    const ordering = scope
      .slice(order + 2)
      .map((p) => p.word)
      .join(" ");
    for (const match of ordering.matchAll(/(?:^|, )(\w+|"[^"]+")(?= (?:asc|desc|nulls|limit|offset|fetch)\b| ,|$)/g))
      if (match[1] && outputs.has(match[1].replaceAll('"', ""))) failures.push(match[1]);
  }
  return failures;
}

test("SQL order guard resolves column templates and keeps SELECT scopes separate", () => {
  const source = `// A plan's revision must win.
    /* The SQL has "quoted" strings. */
    const columns = "id::text"; db.query(\`select \${columns} from plans order by id desc limit 1\`)`;
  assert.deepEqual(
    queries(source).flatMap((q) => textOrders(q.sql)),
    ["id"],
  );
  for (const sql of [
    "select id::text from plans order by id",
    "SELECT p.id::TEXT AS revision FROM plans p ORDER BY revision DESC",
    "select member_id::text, related_id::text from links order by member_id, related_id, kind",
    "select day::text as day from days order by day",
    'select distinct id::text from plans order by "id"',
    "select p.id::text revision from plans p order by revision",
    "select id::text from (select id from other order by id) nested order by id",
    "select id from (select id::text from other order by id) nested order by id",
  ])
    assert.ok(textOrders(sql).length, sql);
  for (const sql of [
    "select id::text from plans order by plans.id desc",
    "select id from plans order by id",
    "select min(effective_on)::text as effective_on from plans",
    "select id::text, (select x from other order by id) as x from plans order by plans.id",
    "select l.id::text, b.as_of::text from loans l left join lateral (select as_of from balances order by as_of desc limit 1) b on true order by l.id",
    "select id::text from plans order by coalesce(id, 0)",
  ])
    assert.deepEqual(textOrders(sql), [], sql);
});

test("core SQL never orders by an unqualified text-cast output column", async () => {
  const root = new URL("./", import.meta.url);
  const failures: string[] = [];
  for (const name of (await readdir(root)).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
    for (const { sql, line } of queries(await readFile(new URL(name, root), "utf8"))) {
      // Upkeep is owned separately. Its ISO date output is safe; its numeric ids remain checked.
      const columns = textOrders(sql).filter((column) => name !== "upkeep.ts" || column !== "next_due_on");
      if (columns.length) failures.push(`${name}:${line}: ${columns.join(", ")} in ${sql.replace(/\s+/g, " ")}`);
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});
