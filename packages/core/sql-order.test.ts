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
  const selects = parts.flatMap((part, i) => {
    if (part.word !== "select") return [];
    const end = parts.findIndex(
      (p, j) => j > i && (p.depth < part.depth || (p.depth === part.depth && p.word === "union")),
    );
    const scope = parts.slice(i + 1, end < 0 ? undefined : end);
    const from = scope.findIndex((p) => p.depth === part.depth && p.word === "from");
    const outputs = new Set<string>();
    let expression = "";
    for (const p of [...scope.slice(0, from), { word: ",", depth: part.depth }]) {
      if (p.word !== "," || p.depth !== part.depth) {
        expression += ` ${p.word}`;
        continue;
      }
      const alias = expression.match(/ (\w+|"[^"]+")$/)?.[1];
      const column = expression.match(/(\w+|"[^"]+") :: text$/)?.[1];
      if (/:: text(?: (?:as )?(?:\w+|"[^"]+"))?$/.test(expression) || /^ (?:distinct )?to_char \(/.test(expression)) {
        const name = column ?? alias;
        if (name) outputs.add(name.replaceAll('"', ""));
      }
      expression = "";
    }
    return [{ i, end: end < 0 ? parts.length : end, depth: part.depth, scope, outputs }];
  });
  const ctes = new Map<string, Set<string>>();
  for (const select of selects) {
    if (parts[select.i - 1]?.word === "(" && parts[select.i - 2]?.word === "as") {
      const name = parts[select.i - 3]?.word;
      if (name) ctes.set(name, select.outputs);
    }
  }
  for (const select of selects) {
    const inputs = new Map<string, Set<string>>();
    for (const [j, p] of select.scope.entries()) {
      if (p.depth !== select.depth || !["from", "join"].includes(p.word)) continue;
      const name = select.scope[j + 1]?.word;
      const columns = name && ctes.get(name);
      if (!columns) continue;
      const next = select.scope[j + 2]?.word;
      const alias = next === "as" ? select.scope[j + 3]?.word : next;
      inputs.set(
        alias &&
          /^[a-z_][a-z_0-9]*$/.test(alias) &&
          !["order", "where", "left", "join", "group", "cross"].includes(alias)
          ? alias
          : name,
        columns,
      );
    }
    for (let j = select.i + 1; j < select.end; j++) {
      const p = parts[j];
      if (p?.word !== "order" || parts[j + 1]?.word !== "by") continue;
      if (selects.some((nested) => nested.i > select.i && nested.i < j && nested.end > j)) continue;
      const ordering: string[] = [];
      for (let k = j + 2; k < select.end; k++) {
        const token = parts[k];
        if (!token || token.depth < p.depth) break;
        if (token.depth === p.depth) ordering.push(token.word);
      }
      for (const match of ordering
        .join(" ")
        .matchAll(/(?:^|, )(?:(\w+|"[^"]+") \. )?(\w+|"[^"]+")(?= (?:asc|desc|nulls|limit|offset|fetch)\b| ,|$)/g)) {
        const qualifier = match[1]?.replaceAll('"', "");
        const column = match[2]?.replaceAll('"', "");
        if (!column) continue;
        const inherited = qualifier
          ? inputs.get(qualifier)?.has(column)
          : [...inputs.values()].some((columns) => columns.has(column));
        if (inherited || (!qualifier && p.depth === select.depth && select.outputs.has(column))) failures.push(column);
      }
    }
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
    "select to_char(day, 'Dy Mon DD') as day from days order by day",
    "select max(id)::text as id from plans order by id",
    "select (id)::text as id from plans order by id",
    "with t as (select p.id::text as revision from plans p) select * from t as revisions order by revisions.revision",
    "with t as (select to_char(day, 'Dy Mon DD') as day from days) select * from t order by t.day",
    "with t as (select id::text from plans) select * from t order by id",
    "with t as (select id::text from plans) select * from t order by t.id",
    "with t as (select id::text from plans) select jsonb_agg(t order by t.id) from t",
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
    "select to_char(day, 'Dy Mon DD') as day from days order by days.day",
    "with t as (select id::text from plans) select * from t order by t.id::bigint",
    "with t as (select id::text from plans) select jsonb_agg(t order by t.id::bigint) from t",
    "with t as (select id::text from plans) select p.id from plans p order by p.id",
    "select min(effective_on)::text as effective_on from plans",
    "select id::text, (select x from other order by id) as x from plans order by plans.id",
    "select l.id::text, b.as_of::text from loans l left join lateral (select as_of from balances order by as_of desc limit 1) b on true order by l.id",
    "select id::text from plans order by coalesce(id, 0)",
  ])
    assert.deepEqual(textOrders(sql), [], sql);
});

test("core SQL never orders by text-converted outputs", async () => {
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
