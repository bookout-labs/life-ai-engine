import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { pageRead, pageWrite } from "../../packages/core/pages.ts";
import { runPages } from "./pages.ts";

const text = z.string().min(1);
const headerSchema = z
  .object({
    status: text,
    retiringThreadId: text,
    blockers: z.array(text),
    nextAction: text,
    detailPaths: z.array(text),
    jobReportPaths: z.array(text),
  })
  .strict();
const packetSchema = z
  .object({
    header: headerSchema,
    standingOrders: text,
    programStore: text,
    state: text,
    jobs: z.array(z.object({ taskId: text, reportingTo: text, reportPath: text, status: text }).strict()),
  })
  .strict();

function render(input: unknown) {
  const packet = packetSchema.parse(input);
  const header = `HANDOFF-HEADER v1\n${JSON.stringify(packet.header)}\n`;
  if (Buffer.byteLength(header) > 2000) throw new Error("Handoff header exceeds 2000 bytes");
  if (new Set(packet.jobs.map((job) => job.taskId)).size !== packet.jobs.length)
    throw new Error("Duplicate task ids in handoff");
  return { header, body: `${header}\n${JSON.stringify(packet)}` };
}

export async function writeHandoff(db: Parameters<typeof pageWrite>[0], slug: string, input: unknown) {
  if (!slug.startsWith("handoff/")) throw new Error("Use a unique handoff/ slug");
  const { body } = render(input);
  await pageWrite(db, {
    slug,
    body,
    type: "project",
    expected_revision: null,
    agent: process.env.CODEX_THREAD_ID ? "codex" : "terminal",
    session: process.env.CODEX_THREAD_ID ?? "terminal",
  });
  const saved = (await pageRead(db, slug))?.body;
  if (saved !== body) throw new Error("Handoff readback differs");
  return { slug, bytes: Buffer.byteLength(saved), sha256: createHash("sha256").update(saved).digest("hex") };
}

function capture() {
  const directory = join(homedir(), ".life-ai", "handoffs", "bootstrap");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${randomUUID()}.bin`);
  const fd = openSync(path, "wx", 0o600);
  let bytes = 0;
  const hash = createHash("sha256");
  let complete = false;
  try {
    const chunk = Buffer.alloc(65536);
    for (;;) {
      const count = readSync(0, chunk, 0, chunk.length, null);
      if (!count) break;
      const data = chunk.subarray(0, count);
      let written = 0;
      while (written < count) written += writeSync(fd, data, written, count - written);
      hash.update(data);
      bytes += count;
    }
    complete = true;
  } finally {
    closeSync(fd);
    if (!complete) unlinkSync(path);
  }
  if (bytes <= 40000) {
    try {
      process.stdout.write(readFileSync(path));
    } finally {
      unlinkSync(path);
    }
  } else
    process.stdout.write(
      JSON.stringify({ schema: "orchestrator-bootstrap/v1", path, bytes, sha256: hash.digest("hex") }),
    );
}

if (import.meta.main) {
  try {
    const [command, slug] = process.argv.slice(2);
    if (command === "capture") capture();
    else if (command === "validate") process.stdout.write(render(JSON.parse(readFileSync(0, "utf8"))).header);
    else if (command === "write" || command === "read") {
      if (!slug?.startsWith("handoff/")) throw new Error("Use a unique handoff/ slug");
      const { db } = await import("./db.ts");
      try {
        if (command === "write") {
          const receipt = await writeHandoff(db, slug, JSON.parse(readFileSync(0, "utf8")));
          process.stdout.write(JSON.stringify(receipt));
        } else {
          const saved = await runPages(db, ["read", slug]);
          const separator = saved.indexOf("\n\n");
          if (separator < 0) throw new Error("Invalid handoff");
          const recovered = render(JSON.parse(saved.slice(separator + 2)));
          if (saved !== recovered.body) throw new Error("Handoff header differs from body");
          process.stdout.write(process.argv.includes("--full") ? recovered.body : recovered.header);
        }
      } finally {
        await db.end();
      }
    } else throw new Error("Usage: handoff.ts capture|validate|write <handoff/slug>|read <handoff/slug> [--full]");
  } catch {
    console.error("Handoff failed. Check the command, private input schema, storage access and header byte limit.");
    process.exitCode = 1;
  }
}
