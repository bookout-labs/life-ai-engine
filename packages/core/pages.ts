import pg from "pg";
import { z } from "zod";

type Db = pg.ClientBase | pg.Pool;
export const slugSchema = z.string().regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/);
export const pageWriteSchema = z.object({
  slug: slugSchema,
  body: z.string(),
  type: z.string().min(1).optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
  created_on: z.iso.date().optional(),
  kind: z.enum(["ingest", "query", "lint", "note", "edit"]).default("edit"),
  agent: z.string().default("unknown"),
  session: z.string().default("unknown"),
  work: z.string().default(""),
  expected_revision: z.string().nullable().optional(),
});
export type Page = {
  id: string;
  slug: string;
  type: string;
  title: string;
  summary: string;
  tags: string[];
  body: string;
  created_on: string;
  updated_at: Date;
  deleted_at: Date | null;
  revision: string | null;
};
export const groups: Record<string, string> = {
  area: "Areas",
  project: "Projects",
  person: "People",
  topic: "Topics",
  source: "Sources",
  answer: "Answers",
  skill: "Skills",
  daily: "Daily notes",
  weekly: "Weekly check-ins",
};
const columns = `p.id::text, p.slug, p.type, p.title, p.summary, p.tags, p.body,
  p.created_on::text, p.updated_at, p.deleted_at,
  (select max(id)::text from page_revisions where page_id=p.id) as revision`;
export async function pageRead(db: Db, slug: string): Promise<Page | undefined> {
  return (
    await db.query<Page>(`select ${columns} from pages p where slug=$1 and deleted_at is null`, [
      slugSchema.parse(slug),
    ])
  ).rows[0];
}
export async function pageList(db: Db, type?: string): Promise<Page[]> {
  return (
    await db.query<Page>(
      `select ${columns} from pages p where deleted_at is null and ($1::text is null or type=$1) order by slug`,
      [type ?? null],
    )
  ).rows;
}
export async function pageSearch(db: Db, text: string): Promise<Page[]> {
  return (
    await db.query<Page>(
      `select ${columns} from pages p, websearch_to_tsquery('english',$1) q
    where deleted_at is null and search @@ q order by ts_rank(search,q) desc, slug limit 100`,
      [text],
    )
  ).rows;
}
export async function pageWrite(db: Db, input: z.input<typeof pageWriteSchema>): Promise<Page> {
  const p = pageWriteSchema.parse(input);
  // Lock in the statement before checking the revision, including concurrent first writes.
  const pooled = db instanceof pg.Pool ? await db.connect() : undefined;
  const client = pooled ?? db;
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [p.slug]);
    const current = await pageRead(client, p.slug);
    if (p.expected_revision !== undefined && (current?.revision ?? null) !== p.expected_revision)
      throw new Error("Page changed since checkout");
    // A save that changes nothing writes nothing, so history and the revision token only move on real edits.
    if (
      current &&
      current.body === p.body &&
      (p.type ?? current.type) === current.type &&
      (p.title ?? current.title) === current.title &&
      (p.summary ?? current.summary) === current.summary &&
      (p.tags ?? current.tags).join("\0") === current.tags.join("\0")
    ) {
      await client.query("commit");
      return current;
    }
    const { rows } = await client.query<{ id: string }>(
      `insert into pages(slug,body,type,title,summary,tags,created_on)
      values($1,$2,$3,$4,$5,$6,coalesce($7::date,current_date)) on conflict(slug) do update set
      body=excluded.body, type=coalesce($8,pages.type), title=coalesce($9,pages.title),
      summary=coalesce($10,pages.summary), tags=coalesce($11,pages.tags), updated_at=now(), deleted_at=null returning id::text`,
      [
        p.slug,
        p.body,
        p.type ?? "other",
        p.title ?? p.slug,
        p.summary ?? "",
        p.tags ?? [],
        p.created_on ?? null,
        p.type ?? null,
        p.title ?? null,
        p.summary ?? null,
        p.tags ?? null,
      ],
    );
    await client.query(`insert into page_revisions(page_id,body,kind,agent,session,work) values($1,$2,$3,$4,$5,$6)`, [
      rows[0]?.id,
      p.body,
      p.kind,
      p.agent,
      p.session,
      p.work,
    ]);
    const result = await pageRead(client, p.slug);
    if (!result) throw new Error("Page write failed");
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    pooled?.release();
  }
}
export async function pageDelete(db: Db, slug: string): Promise<void> {
  await db.query("update pages set deleted_at=now(), updated_at=now() where slug=$1 and deleted_at is null", [
    slugSchema.parse(slug),
  ]);
}
export async function pageLog(db: Db, since = "1970-01-01"): Promise<pg.QueryResultRow[]> {
  return (
    await db.query(
      `select p.slug,r.* from page_revisions r join pages p on p.id=r.page_id where saved_at >= $1::timestamptz order by saved_at desc,r.id desc`,
      [since],
    )
  ).rows;
}
export function renderList(pages: Page[]): string {
  return [...Object.keys(groups), "other"]
    .flatMap((type) => {
      const rows = pages
        .filter((p) => (type === "other" ? !(p.type in groups) : p.type === type))
        .sort((a, b) => a.slug.localeCompare(b.slug));
      if (type === "daily" || type === "weekly") rows.reverse();
      return rows.length
        ? [`## ${groups[type] ?? "Other"}`, ...rows.map((p) => `${p.slug} | ${p.type} | ${p.summary}`), ""]
        : [];
    })
    .join("\n");
}
export type StoredFile = {
  key: string;
  sha256: string;
  mime: string;
  bytes: string;
  title: string;
  source_page_id: string | null;
  repo_path: string | null;
};
export async function fileRead(db: Db, key: string): Promise<StoredFile | undefined> {
  return (await db.query<StoredFile>("select * from files where key=$1", [key])).rows[0];
}
export async function fileWrite(
  db: Db,
  file: { key: string; sha256: string; mime: string; bytes: number; title: string; page?: string; repo_path?: string },
): Promise<void> {
  if (file.page && !(await pageRead(db, file.page))) throw new Error("Source page not found");
  await db.query(
    `insert into files(key,sha256,mime,bytes,title,source_page_id,repo_path) values($1,$2,$3,$4,$5,(select id from pages where slug=$6 and deleted_at is null),$7)
    on conflict(key) do update set title=excluded.title,source_page_id=coalesce(excluded.source_page_id,files.source_page_id),repo_path=coalesce(excluded.repo_path,files.repo_path)`,
    [file.key, file.sha256, file.mime, file.bytes, file.title, file.page ?? null, file.repo_path ?? null],
  );
}
