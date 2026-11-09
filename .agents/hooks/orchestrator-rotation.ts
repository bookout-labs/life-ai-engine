import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const marker = "Life-AI-Session-Role: orchestrator";
const eventSchema = z.object({
  hook_event_name: z.enum(["Stop", "PreCompact"]),
  session_id: z.string().min(1),
  transcript_path: z.string().min(1),
  agent_id: z.string().nullish(),
  trigger: z.string().optional(),
});
const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative(),
});
const contentSchema = z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]);
const rowSchema = z.object({
  type: z.string(),
  sessionId: z.string().optional(),
  isSidechain: z.boolean().optional(),
  isMeta: z.boolean().optional(),
  message: z.object({ content: contentSchema.optional(), usage: z.unknown().optional() }).optional(),
  payload: z
    .object({ type: z.string().optional(), message: z.string().optional(), id: z.string().optional() })
    .optional(),
});

const handoff = `Prepare a private Life AI orchestrator handoff now.
Read docs/orchestrator-handoff.md for the required JSON contract.
Write through node .agents/scripts/handoff.ts write handoff/<unique-slug> from stdin JSON.
Use HANDOFF-HEADER v1 of at most 2,000 UTF-8 bytes with status, retiring T3 thread id,
blockers, next action, detailed state paths and job report paths. Include standing orders,
program store, exact branches and PRs, decisions, and EVERY running job with task id,
reporting thread/link and report path in the detailed body. Reconcile against the live
T3 task inventory and ~/.life-ai/orchestrate/life-ai-builds before writing. Missing jobs
are not safe to infer. Do not use the provider session id as the retiring T3 thread id.
Personal prose belongs in Neon through pages.ts. Large artifacts belong in private files
or R2. Capture bootstrap stdout with set -o pipefail; <command> | node .agents/scripts/handoff.ts capture. Over 40,000 bytes returns only private path, bytes
and SHA256. Required source reads still apply.
Read back using node .agents/scripts/handoff.ts read handoff/<unique-slug> before retiring.
Use --full after the header to recover the detailed state and active jobs.
A successor starts with poteto-mode Orchestrate and Session pickup, reads the header
first, restores standing orders and the program store, then inspects every active job
without restarting it. Preserve task ids and reporting destinations.
Only launch a new top-level T3 thread if current user/session authorization explicitly
permits this successor. A token threshold grants no launch authority. Otherwise leave
the verified handoff for a resumed coordinator and report the recovery slug.
Include the retiring T3 thread id and ${marker} in any authorized successor prompt.
Neither seat may archive the retiring thread. Leave pins unchanged without explicit
prior authority. Post an authorized successor's returned link, then stop this seat.`;

function snapshot(path: string, session: string, provider: "claude" | "codex") {
  let firstPrompt: string | undefined;
  let latest: unknown;
  let codexSession: string | undefined;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = rowSchema.parse(JSON.parse(line));
    if (row.sessionId !== undefined && row.sessionId !== session) continue;
    if (row.isSidechain) continue;
    if (provider === "codex") {
      if (row.type === "session_meta") codexSession = row.payload?.id;
      if (row.type === "event_msg" && row.payload?.type === "user_message" && firstPrompt === undefined)
        firstPrompt = row.payload.message ?? "";
    } else {
      if (row.type === "user" && !row.isMeta && firstPrompt === undefined) {
        const content = row.message?.content;
        firstPrompt =
          typeof content === "string"
            ? content
            : (content
                ?.filter((b) => b.type === "text")
                .map((b) => b.text ?? "")
                .join("\n") ?? "");
      }
      if (row.type === "assistant") latest = row.message?.usage;
    }
  }
  if (provider === "codex" && codexSession !== session) return undefined;
  if (!firstPrompt?.split(/\r?\n/).includes(marker)) return undefined;
  if (latest === undefined) return { tokens: 0 };
  const usage = usageSchema.parse(latest);
  return { tokens: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens };
}

function decide(input: unknown, provider: "claude" | "codex") {
  const event = eventSchema.parse(input);
  if (event.agent_id || (event.hook_event_name === "PreCompact" && event.trigger !== "auto")) return;
  const current = snapshot(event.transcript_path, event.session_id, provider);
  if (!current) return;
  const threshold =
    process.env.LIFE_AI_ROTATION_TOKENS === undefined
      ? undefined
      : z.coerce.number().int().positive().parse(process.env.LIFE_AI_ROTATION_TOKENS);
  const directory = join(homedir(), ".life-ai", "orchestrator-rotation");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(
    directory,
    `${createHash("sha256").update(`${provider}:${event.session_id}`).digest("hex")}.sqlite`,
  );
  const db = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
    db.exec("PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS claims (event TEXT PRIMARY KEY); BEGIN IMMEDIATE");
    const compact = event.hook_event_name === "PreCompact";
    const guarded = Boolean(db.prepare("SELECT event FROM claims WHERE event='PreCompact'").get());
    if (!compact && !guarded && (provider === "codex" || threshold === undefined || current.tokens < threshold)) {
      db.exec("ROLLBACK");
      return;
    }
    const result = db.prepare("INSERT OR IGNORE INTO claims(event) VALUES (?)").run(event.hook_event_name);
    db.exec("COMMIT");
    if (!result.changes) return;
    return provider === "codex" && compact
      ? { continue: false, stopReason: handoff }
      : { decision: "block", reason: handoff };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  try {
    const provider = z.enum(["claude", "codex"]).parse(process.argv[2]);
    const result = decide(JSON.parse(readFileSync(0, "utf8")), provider);
    if (result) process.stdout.write(JSON.stringify(result));
  } catch {
    // Hooks fail open. Handoff and capture commands fail visibly instead.
  }
}
