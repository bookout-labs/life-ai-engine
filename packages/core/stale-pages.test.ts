import assert from "node:assert/strict";
import test from "node:test";
import { classifyStalePages } from "./stale-pages.ts";

const row = (slug: string, type = "project", body = "", updated = "2040-01-01", deleted = false) => ({
  slug,
  type,
  body,
  updated_at: new Date(`${updated}T12:00:00Z`),
  deleted_at: deleted ? new Date() : null,
});

test("age limit is crossed after the boundary day", () => {
  assert.deepEqual(classifyStalePages([row("p")], "2040-01-31"), []);
  assert.deepEqual(classifyStalePages([row("p")], "2040-02-01"), [
    { slug: "p", reasons: [{ kind: "age", updated_on: "2040-01-01", limit_days: 30 }] },
  ]);
});

test("dated statements and broken links identify their evidence", () => {
  const rows = [
    row("p", "project", "# Current state (2039-12-01)\n[[gone]] `areas/missing.md` [[present]]", "2040-02-01"),
    row("present", "project", "", "2040-02-01"),
    row("gone", "project", "", "2040-02-01", true),
  ];
  assert.deepEqual(classifyStalePages(rows, "2040-02-01"), [
    {
      slug: "p",
      reasons: [
        { kind: "dated_statement", date: "2039-12-01", line: "# Current state (2039-12-01)", limit_days: 30 },
        { kind: "broken_link", target: "gone" },
        { kind: "broken_link", target: "areas/missing" },
      ],
    },
  ]);
});

test("history dates, inline code and links by slug ending do not trigger", () => {
  const body =
    "| 2039-01-05 | logged |\nDecided 2039-01-05.\nRun `npm` on `main` or `foo/bar`.\n[[jo]] [[people/jo]] `people/jo.md`";
  const rows = [row("p", "project", body, "2040-02-01"), row("people/jo", "person", "", "2040-02-01")];
  assert.deepEqual(classifyStalePages(rows, "2040-02-01"), []);
});

test("recent and invalid dates, frontmatter, and log pages do not trigger", () => {
  const rows = [
    row("p", "project", "---\ncreated: 2030-01-01\n---\n# State (2040-01-02)\n# Bad 2039-02-30", "2040-02-01"),
    ...[
      row("daily/a", "daily", "[[missing]]"),
      row("weekly/a", "weekly", "[[missing]]"),
      row("handoff/a", "other", "[[missing]]"),
    ],
  ];
  assert.deepEqual(classifyStalePages(rows, "2040-02-01"), []);
});

test("reader includes deleted targets in its snapshot but excludes deleted pages", {
  skip: !process.env.STALE_TEST_DATABASE_URL,
}, async () => {
  const { default: pg } = await import("pg");
  const { stalePages } = await import("./stale-pages.ts");
  const db = new pg.Client({ connectionString: process.env.STALE_TEST_DATABASE_URL });
  await db.connect();
  try {
    await db.query(
      "create temporary table pages (slug text, type text, body text, updated_at timestamptz, deleted_at timestamptz)",
    );
    await db.query(
      "insert into pages values ('source', 'project', '[[deleted]] [[live]]', '2040-02-01', null), ('deleted', 'project', '', '2040-02-01', '2040-02-01'), ('live', 'project', '', '2040-02-01', null)",
    );
    assert.deepEqual(await stalePages(db, "2040-02-01"), [
      { slug: "source", reasons: [{ kind: "broken_link", target: "deleted" }] },
    ]);
  } finally {
    await db.end();
  }
});

test("type limits distinguish recent from stale pages", () => {
  const pages = [row("a", "area"), row("p", "person"), row("i", "inbox"), row("o", "other")];
  assert.deepEqual(
    classifyStalePages(pages, "2040-01-09").map((page) => page.slug),
    ["i"],
  );
  assert.deepEqual(
    classifyStalePages(pages, "2040-04-01").map((page) => page.slug),
    ["a", "p", "i", "o"],
  );
});
