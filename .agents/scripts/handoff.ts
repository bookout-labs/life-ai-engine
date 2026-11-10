// Coordinator handoff: a create-only Neon page with a strict packet, read back header-first (#141).
import { readFileSync } from "node:fs";
import { z } from "zod";
import { pageRead, pageWrite } from "../../packages/core/pages.ts";

const text = z.string().min(1);
const packet = z
  .strictObject({
    header: z.strictObject({
      status: text,
      retiringThreadId: text,
      blockers: z.array(text),
      nextAction: text,
      detailPaths: z.array(text),
      jobReportPaths: z.array(text),
    }),
    standingOrders: text,
    programStore: text,
    state: text,
    jobs: z.array(z.strictObject({ taskId: text, reportingTo: text, reportPath: text, status: text })),
  })
  .refine((p) => new Set(p.jobs.map((job) => job.taskId)).size === p.jobs.length, "Duplicate task ids in handoff");

export function renderHandoff(input: unknown) {
  const value = packet.parse(input);
  const header = `HANDOFF-HEADER v1\n${JSON.stringify(value.header)}\n`;
  if (Buffer.byteLength(header) > 2000) throw new Error("Handoff header exceeds 2000 bytes");
  return { header, body: `${header}\n${JSON.stringify(value)}` };
}

export async function writeHandoff(db: Parameters<typeof pageWrite>[0], slug: string, input: unknown) {
  const { body } = renderHandoff(input);
  const saved = await pageWrite(db, {
    slug,
    body,
    type: "project",
    expected_revision: null,
    agent: process.env.CODEX_THREAD_ID ? "codex" : "terminal",
    session: process.env.CODEX_THREAD_ID ?? "terminal",
  });
  if (saved.body !== body) throw new Error("Handoff readback differs");
  return { slug, bytes: Buffer.byteLength(body) };
}

if (import.meta.main) {
  try {
    const [command, slug] = process.argv.slice(2);
    if (!["write", "read"].includes(command ?? "") || !slug?.startsWith("handoff/"))
      throw new Error("Usage: handoff.ts write|read handoff/<slug> [--full]");
    const { db } = await import("./db.ts");
    try {
      if (command === "write") {
        process.stdout.write(JSON.stringify(await writeHandoff(db, slug, JSON.parse(readFileSync(0, "utf8")))));
      } else {
        const saved = (await pageRead(db, slug))?.body ?? "";
        const recovered = renderHandoff(JSON.parse(saved.slice(saved.indexOf("\n\n") + 2)));
        if (saved !== recovered.body) throw new Error("Handoff header differs from body");
        process.stdout.write(process.argv.includes("--full") ? recovered.body : recovered.header);
      }
    } finally {
      await db.end();
    }
  } catch {
    // JSON and schema errors can quote the private input, so the message stays generic.
    console.error(
      "Handoff failed. Check the command, the packet shape, storage access and the 2,000-byte header limit.",
    );
    process.exitCode = 1;
  }
}
