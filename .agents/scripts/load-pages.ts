import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import type pg from "pg";
import { parse } from "yaml";
import { z } from "zod";
import { groups, pageList, pageRead, pageWrite, pageWriteSchema, renderList } from "../../packages/core/pages.ts";
import { resolveLink, slugFor } from "../../packages/core/wiki-links.ts";

export { resolveLink, slugFor } from "../../packages/core/wiki-links.ts";

import { getFile, putFile } from "./files.ts";

const roots = ["wiki", "areas", "projects", "daily", "weekly", "inbox"];
export async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const paths = await Promise.all(
    entries
      .filter((e) => !e.name.startsWith("."))
      .map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : Promise.resolve([join(dir, e.name)]))),
  );
  return paths.flat();
}
export function parsePage(path: string, body: string) {
  const fm = z
    .object({
      type: z.string().optional(),
      title: z.string().optional(),
      summary: z.string().optional(),
      tags: z.array(z.string()).optional(),
      created: z.string().optional(),
      created_on: z.string().optional(),
    })
    .parse(parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(body)?.[1] ?? "") ?? {});
  return pageWriteSchema.parse({
    slug: slugFor(path),
    body,
    type: fm.type ?? "other",
    title: fm.title ?? /^# (.+)$/m.exec(body)?.[1] ?? basename(path, ".md"),
    summary: fm.summary ?? "",
    tags: fm.tags ?? [],
    created_on: fm.created_on ?? fm.created,
    kind: "ingest",
    agent: "loader",
    session: "migration",
    work: "94",
  });
}
export async function loadPages(db: pg.Pool, root: string, write: boolean) {
  const paths = (await Promise.all(roots.map((r) => walk(join(root, r)))))
    .flat()
    .filter((p) => p.endsWith(".md"))
    .sort();
  const pages = await Promise.all(
    paths.map(async (path) => parsePage(relative(root, path), await readFile(path, "utf8"))),
  );
  const slugs = new Set(pages.map((p) => p.slug));
  let links = 0,
    unresolved = 0;
  for (const p of pages)
    for (const match of p.body.matchAll(/\[\[([^\]]+)\]\]/g)) {
      links++;
      if (!resolveLink(match[1] ?? "", p.slug, slugs)) unresolved++;
    }
  if (write)
    for (const p of pages) {
      const old = await pageRead(db, p.slug);
      if (
        !old ||
        old.body !== p.body ||
        old.type !== p.type ||
        old.summary !== p.summary ||
        JSON.stringify(old.tags) !== JSON.stringify(p.tags)
      )
        await pageWrite(db, p);
    }
  const stored = await pageList(db);
  assert.equal(stored.length, pages.length, "page count");
  let identical = 0;
  for (const p of pages) {
    const row = await pageRead(db, p.slug);
    assert.equal(row?.body, p.body, "body mismatch");
    assert.equal(row?.type, p.type);
    assert.equal(row?.summary, p.summary);
    assert.deepEqual(row?.tags, p.tags);
    if (p.created_on) assert.equal(row?.created_on, p.created_on);
    identical++;
  }
  const index = await readFile(join(root, "INDEX.md"), "utf8");
  const expected = new Map<string, string[]>();
  let heading = "";
  for (const line of index.split("\n")) {
    if (line.startsWith("## ")) heading = line.slice(3);
    const path = /^- \[[^\]]+\]\(([^)]+)\)/.exec(line)?.[1];
    if (path && roots.some((r) => path.startsWith(`${r}/`))) {
      const slug = slugFor(path);
      const items = expected.get(heading) ?? [];
      items.push(slug);
      expected.set(heading, items);
    }
  }
  const listing = renderList(stored);
  let matchedGroups = 0;
  for (const [name, slugs] of expected) {
    const type = Object.entries(groups).find(([, label]) => label === name)?.[0];
    const actual = stored
      .filter((p) => (type ? p.type === type : !(p.type in groups)))
      .map((p) => p.slug)
      .sort();
    assert.deepEqual(actual, [...slugs].sort(), "INDEX group mismatch");
    assert.ok(listing.includes(`## ${name}`));
    matchedGroups++;
  }
  const originals = (await Promise.all(["raw", "archive"].map((r) => walk(join(root, r))))).flat();
  const scratch = await mkdtemp(join(tmpdir(), "life-ai-files-"));
  let files = 0;
  try {
    for (const path of originals) {
      if (!write) continue;
      const repoPath = relative(root, path);
      const sources = pages.filter((p, index) =>
        [...p.body.matchAll(/\[\[([^\]]+)\]\]|\]\(([^)]+)\)/g)].some((match) => {
          const target = (match[1] ?? match[2] ?? "").split("|")[0]?.split("#")[0] ?? "";
          return target === repoPath || resolve(dirname(paths[index] ?? root), target) === path;
        }),
      );
      const source = sources.find((p) => p.type === "source") ?? sources[0];
      const key = await putFile(db, path, source?.slug, repoPath);
      const output = join(scratch, "download");
      await getFile(db, key, output);
      assert.deepEqual(await readFile(output), await readFile(path), "R2 body mismatch");
      files++;
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const evidence = { pages: pages.length, identical, links, unresolved, index_groups: matchedGroups, files };
  console.log(JSON.stringify(evidence));
  assert.equal(unresolved, 0, "unresolved wikilinks");
  return evidence;
}
if (import.meta.main) {
  const { db } = await import("./db.ts");
  try {
    await loadPages(db, resolve(process.argv[2] ?? "."), process.argv.includes("--write"));
  } finally {
    await db.end();
  }
}
