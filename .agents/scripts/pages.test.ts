import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import pg from "pg";
import {
  fileRead,
  fileWrite,
  groups,
  pageDelete,
  pageList,
  pageLog,
  pageRead,
  pageSearch,
  pageWrite,
  slugSchema,
} from "../../packages/core/pages.ts";
import { temporarySchema } from "../../packages/core/test-schema.ts";
import { resolveLink, slugFor } from "../../packages/core/wiki-links.ts";
import { getFile, putFile } from "./files.ts";
import { runPages } from "./pages.ts";

test("canonical links resolve full and shorthand targets and page slugs reject unsafe paths", () => {
  const slugs = new Set(["topics/example", "people/person", "areas/plan"]);
  assert.equal(resolveLink("wiki/people/person.md#section|Label", "topics/example", slugs), "people/person");
  assert.equal(resolveLink("person", "topics/example", slugs), "people/person");
  assert.equal(resolveLink("#section", "topics/example", slugs), "topics/example");
  assert.equal(resolveLink("missing", "topics/example", slugs), undefined);
  assert.equal(resolveLink("example", "areas/plan", new Set(["topics/example", "people/example"])), undefined);
  assert.equal(slugFor("areas/plan.md"), "areas/plan");
  for (const slug of ["../escape", "a/../../b", "/absolute", "a//b", "a.md"])
    assert.equal(slugSchema.safeParse(slug).success, false);
});

test("Postgres and CLI round trip, revisions, conflict, search, soft delete and files", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  const home = await mkdtemp(join(tmpdir(), "life-ai-pages-test-"));
  try {
    await db.query(await temporarySchema());
    if (process.env.LIFE_AI_FILE_TEST === "1") {
      const original = join(home, "synthetic.txt");
      await writeFile(original, `Synthetic integration fixture ${process.pid}\n`);
      const key = await putFile(db, original);
      try {
        const downloaded = join(home, "download.txt");
        await getFile(db, key, downloaded);
        assert.deepEqual(await readFile(downloaded), await readFile(original));
      } finally {
        execFileSync(
          "npx",
          ["--no-install", "wrangler", "r2", "object", "delete", `life-ai-files/${key}`, "--remote"],
          { stdio: "pipe" },
        );
      }
    }
    const input = {
      slug: "topics/example",
      body: "# Example\r\n\nA distinctive nectarine.\n",
      type: "topic",
      summary: "An example",
      tags: ["one"],
      agent: "test",
    };
    const first = await pageWrite(db, input);
    assert.equal(first.body, input.body);
    assert.equal((await pageList(db)).length, 1);
    assert.equal((await pageSearch(db, "nectarine"))[0]?.slug, input.slug);
    assert.equal((await pageLog(db)).length, 1);
    assert.equal(await runPages(db, ["read", input.slug], home), input.body);
    assert.match(await runPages(db, ["list"], home), new RegExp(`## ${groups.topic}`));
    assert.match(await runPages(db, ["search", "nectarine"], home), /topics\/example/);
    const scratch = await runPages(db, ["edit", input.slug], home);
    await assert.rejects(runPages(db, ["edit", input.slug], home), /EEXIST/);
    await writeFile(scratch, "Edited body\n");
    await runPages(db, ["save", input.slug], home);
    assert.equal((await pageRead(db, input.slug))?.body, "Edited body\n");
    await assert.rejects(readFile(scratch), /ENOENT/);
    await runPages(db, ["edit", input.slug], home);
    await pageWrite(db, { ...input, body: "Remote body\n" });
    await assert.rejects(runPages(db, ["save", input.slug], home), /changed since checkout/);
    assert.equal((await pageRead(db, input.slug))?.body, "Remote body\n");
    const revisions = (await pageLog(db)).length;
    await assert.rejects(pageWrite(db, { ...input, body: "Rejected", expected_revision: first.revision }), /changed/);
    assert.equal((await pageLog(db)).length, revisions);
    await pageDelete(db, input.slug);
    assert.equal(await pageRead(db, input.slug), undefined);
    assert.equal((await pageSearch(db, "nectarine")).length, 0);
    assert.equal((await pageList(db)).length, 0);
    assert.equal((await pageLog(db)).length, revisions);
    await runPages(db, ["write", input.slug, "--type", "topic", "--kind", "note"], home, Readable.from([input.body]));
    assert.equal((await pageRead(db, input.slug))?.body, input.body);
    assert.equal((await pageLog(db))[0]?.kind, "note");
    const revision = (await pageRead(db, input.slug))?.revision;
    const results = await Promise.allSettled([
      pageWrite(db, { ...input, body: "one", expected_revision: revision }),
      pageWrite(db, { ...input, body: "two", expected_revision: revision }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const file = {
      key: "raw/test.txt",
      sha256: "a".repeat(64),
      mime: "text/plain",
      bytes: 3,
      title: "Test",
      page: input.slug,
      repo_path: "raw/original.txt",
    };
    await fileWrite(db, file);
    await fileWrite(db, { key: file.key, sha256: file.sha256, mime: file.mime, bytes: file.bytes, title: file.title });
    assert.equal((await fileRead(db, file.key))?.repo_path, file.repo_path);
    assert.equal((await fileRead(db, file.key))?.source_page_id, first.id);
    await assert.rejects(fileWrite(db, { ...file, key: "raw/missing", page: "topics/missing" }), /not found/);
    assert.equal(await fileRead(db, "raw/missing"), undefined);
  } finally {
    await db.end();
    await rm(home, { recursive: true, force: true });
  }
});
