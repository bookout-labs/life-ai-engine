import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { parseArgs } from "node:util";
import type pg from "pg";
import {
  pageDelete,
  pageList,
  pageLog,
  pageRead,
  pageSearch,
  pageWrite,
  pageWriteSchema,
  renderList,
  slugSchema,
} from "../../packages/core/pages.ts";

export async function runPages(
  db: pg.Pool | pg.Client,
  args: string[],
  home = homedir(),
  stdin: Readable = process.stdin,
): Promise<string> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: Object.fromEntries(
      ["type", "title", "summary", "tags", "kind", "agent", "session", "work"].map((k) => [
        k,
        { type: "string" as const },
      ]),
    ),
  });
  const [command, argument] = positionals;
  if (command === "list") return renderList(await pageList(db, argument));
  if (command === "log") return JSON.stringify(await pageLog(db, argument));
  if (command === "search") return JSON.stringify(await pageSearch(db, positionals.slice(1).join(" ")));
  const slug = slugSchema.parse(argument);
  const scratch = join(home, ".life-ai", "pages", `${slug}.md`);
  if (command === "read") {
    const p = await pageRead(db, slug);
    if (!p) throw new Error("Page not found");
    return p.body;
  }
  if (command === "delete") {
    await pageDelete(db, slug);
    return "";
  }
  if (command === "edit") {
    const p = await pageRead(db, slug);
    if (!p) throw new Error("Page not found");
    await mkdir(dirname(scratch), { recursive: true, mode: 0o700 });
    await writeFile(scratch, p.body, { flag: "wx", mode: 0o600 });
    await writeFile(`${scratch}.json`, JSON.stringify({ revision: p.revision }), { mode: 0o600 });
    return scratch;
  }
  if (command === "write" || command === "save") {
    let body: string;
    let expected_revision: string | null | undefined;
    if (command === "save") {
      body = await readFile(scratch, "utf8");
      const { z } = await import("zod");
      expected_revision = z
        .object({ revision: z.string().nullable() })
        .parse(JSON.parse(await readFile(`${scratch}.json`, "utf8"))).revision;
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
      body = Buffer.concat(chunks).toString("utf8");
    }
    const p = await pageWrite(
      db,
      pageWriteSchema.parse({
        slug,
        body,
        ...values,
        tags: values.tags?.split(",").filter(Boolean),
        expected_revision,
        agent: values.agent ?? (process.env.CODEX_THREAD_ID ? "codex" : "terminal"),
        session: values.session ?? process.env.CODEX_THREAD_ID ?? "terminal",
      }),
    );
    if (command === "save") {
      await unlink(scratch);
      await unlink(`${scratch}.json`);
    }
    return p.slug;
  }
  throw new Error("Usage: pages.ts list|read|search|log|write|edit|save|delete [slug]");
}
if (import.meta.main) {
  const { db } = await import("./db.ts");
  try {
    process.stdout.write(await runPages(db, process.argv.slice(2)));
  } finally {
    await db.end();
  }
}
