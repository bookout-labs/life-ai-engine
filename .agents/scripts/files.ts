import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type pg from "pg";
import { fileRead, fileWrite, pageRead } from "../../packages/core/pages.ts";

export async function putFile(
  db: pg.Pool | pg.Client,
  path: string,
  page?: string,
  repoPath?: string,
): Promise<string> {
  if (page && !(await pageRead(db, page))) throw new Error("Source page not found");
  const local = relative(resolve(import.meta.dirname, "../.."), resolve(path));
  const originalPath = repoPath ?? (!local.startsWith("..") && !isAbsolute(local) ? local : undefined);
  const body = await readFile(path);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const ext = extname(path)
    .slice(1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const key = `raw/${sha256}${ext ? `.${ext}` : ""}`;
  const scratch = await mkdtemp(join(tmpdir(), "life-ai-upload-"));
  let mime: string;
  try {
    const snapshot = join(scratch, "body");
    await writeFile(snapshot, body, { mode: 0o600 });
    mime = execFileSync("file", ["--brief", "--mime-type", snapshot], { encoding: "utf8" }).trim();
    execFileSync(
      "npx",
      [
        "--no-install",
        "wrangler",
        "r2",
        "object",
        "put",
        `life-ai-files/${key}`,
        "--file",
        snapshot,
        "--content-type",
        mime,
        "--remote",
      ],
      { stdio: "pipe" },
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  await fileWrite(db, {
    key,
    sha256,
    mime,
    bytes: body.length,
    title: basename(path),
    ...(page ? { page } : {}),
    ...(originalPath ? { repo_path: originalPath } : {}),
  });
  return key;
}
export async function getFile(db: pg.Pool | pg.Client, key: string, output: string): Promise<void> {
  const metadata = await fileRead(db, key);
  if (!metadata) throw new Error("File not found");
  execFileSync(
    "npx",
    ["--no-install", "wrangler", "r2", "object", "get", `life-ai-files/${key}`, "--file", resolve(output), "--remote"],
    { stdio: "pipe" },
  );
  const body = await readFile(output);
  if (createHash("sha256").update(body).digest("hex") !== metadata.sha256) throw new Error("File checksum mismatch");
}
if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { page: { type: "string" }, output: { type: "string" }, "repo-path": { type: "string" } },
  });
  const { db } = await import("./db.ts");
  try {
    const [command, arg] = positionals;
    if (!arg)
      throw new Error("Usage: files.ts put <path> [--page slug] [--repo-path path] | get <key> [--output path]");
    if (command === "put") console.log(await putFile(db, arg, values.page, values["repo-path"]));
    else if (command === "get") await getFile(db, arg, values.output ?? basename(arg));
    else throw new Error("Unknown command");
  } finally {
    await db.end();
  }
}
