import type pg from "pg";
import type { Page } from "./pages.ts";

export type StalePageRow = Pick<Page, "slug" | "type" | "body" | "updated_at" | "deleted_at">;
type StaleReason =
  | { kind: "age"; updated_on: string; limit_days: number }
  | { kind: "dated_statement"; date: string; line: string; limit_days: number }
  | { kind: "broken_link"; target: string };
export type StalePage = { slug: string; reasons: StaleReason[] };

const limits = new Map([
  ["area", 90],
  ["person", 90],
  ["project", 30],
  ["inbox", 7],
]);
const day = 86_400_000;

export function classifyStalePages(rows: StalePageRow[], asOf: string): StalePage[] {
  const now = Date.parse(`${asOf}T00:00:00Z`);
  const live = rows.filter((row) => !row.deleted_at).map((row) => row.slug);
  // Wiki links name a page by its slug or by the slug's last segment, as in [[people/x]] or [[x]].
  const targets = new Set([...live, ...live.map((slug) => slug.slice(slug.lastIndexOf("/") + 1))]);
  return rows.flatMap((row) => {
    if (row.deleted_at || row.type === "daily" || row.type === "weekly" || row.slug.startsWith("handoff/")) return [];
    const limit = limits.get(row.type) ?? 90;
    const reasons: StaleReason[] = [];
    const updated = row.updated_at.toISOString().slice(0, 10);
    if (now - Date.parse(`${updated}T00:00:00Z`) > limit * day)
      reasons.push({ kind: "age", updated_on: updated, limit_days: limit });
    const body = row.body.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
    // Only a dated heading claims current state; dates in tables and logs are history.
    for (const line of body.split(/\r?\n/).filter((text) => text.startsWith("#"))) {
      for (const match of line.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) {
        const date = match[0];
        const parsed = Date.parse(`${date}T00:00:00Z`);
        if (
          Number.isFinite(parsed) &&
          new Date(parsed).toISOString().slice(0, 10) === date &&
          now - parsed > limit * day
        )
          reasons.push({ kind: "dated_statement", date, line, limit_days: limit });
      }
    }
    const missing = new Set<string>();
    for (const match of body.matchAll(
      /\[\[([a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)\]\]|`((?:areas|projects|people|inbox)\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)(?:\.md)?`/g,
    )) {
      const target = match[1] ?? match[2];
      if (target && !targets.has(target)) missing.add(target);
    }
    for (const target of missing) reasons.push({ kind: "broken_link", target });
    return reasons.length ? [{ slug: row.slug, reasons }] : [];
  });
}

export async function stalePages(db: pg.ClientBase | pg.Pool, asOf: string): Promise<StalePage[]> {
  const { rows } = await db.query<StalePageRow>(
    "select slug, type, body, updated_at, deleted_at from pages order by slug",
  );
  return classifyStalePages(rows, asOf);
}
