// Coordinator rotation without compaction (#145). Each agent counts its own tokens: automatic compaction fires at
// 400k (CLAUDE_CODE_AUTO_COMPACT_WINDOW, model_auto_compact_token_limit). Claude asks for the handoff at the first
// Stop past 350k, so the handoff turn ends before 400k: a blocked compaction retries before every model call (#221).
// The 400k block stays as the backstop, so the handoff always runs with the full context.
// Blocking wedges Codex (the next turn hits the limit again, #145), so Codex compacts once and hands off at that Stop.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nonempty, optionalString, record, string } from "./parse.ts";

const marker = "Life-AI-Session-Role: orchestrator";
function parseEvent(input: unknown) {
  const event = record(input);
  const name = string(event.hook_event_name);
  if (!["UserPromptSubmit", "Stop", "PreCompact"].includes(name)) throw new Error("Unknown hook event");
  return {
    hook_event_name: name,
    session_id: nonempty(event.session_id),
    prompt: optionalString(event.prompt),
    agent_id: event.agent_id == null ? undefined : nonempty(event.agent_id),
    trigger: optionalString(event.trigger),
    transcript_path: event.transcript_path == null ? undefined : string(event.transcript_path),
  };
}

const blocked =
  "Automatic compaction is blocked for this coordinator. Finish the current step, then hand off: the next stop gives the handoff steps.";

const codexHandoff =
  "Codex just compacted this coordinator at its 400k limit. Hand off now: your messages are intact; take everything else from the compacted summary and the program store on disk.";

const handoff = `Prepare a private Life AI orchestrator handoff now, while the full context is still here.
Read docs/orchestrator-handoff.md for the required JSON contract.
Write through node .agents/scripts/handoff.ts write handoff/<unique-slug> from stdin JSON.
Use HANDOFF-HEADER v1 of at most 2,000 UTF-8 bytes with status, retiring T3 thread id,
blockers, next action, detailed state paths and job report paths. Include standing orders,
program store, exact branches and PRs, decisions, and EVERY running job with task id,
reporting thread/link and report path in the detailed body. Reconcile against the live
T3 task inventory and ~/.life-ai/orchestrate/life-ai-builds before writing. Missing jobs
are not safe to infer. Do not use the provider session id as the retiring T3 thread id.
Personal prose belongs in Neon through pages.ts. Large artifacts belong in private files
or R2. Required source reads still apply.
Read back using node .agents/scripts/handoff.ts read handoff/<unique-slug> before retiring.
Use --full after the header to recover the detailed state and active jobs.
A successor starts with poteto-mode Orchestrate and Session pickup, reads the header
first, restores standing orders and the program store, then inspects every active job
without restarting it. Preserve task ids and reporting destinations.
Always launch the successor as a new top-level T3 thread, pin it and unpin this one.
Include the retiring T3 thread id and ${marker} in the successor prompt.
Neither seat may archive the retiring thread. Post the successor's returned link,
then stop this seat.`;

// Context size is the last main-thread call's input; a missing transcript leaves the 400k backstop.
function contextTokens(path: string | undefined): number {
  const rows = path && existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  for (const line of rows.reverse().filter((row) => row.includes('"usage"'))) {
    const row = JSON.parse(line);
    const usage = row.message?.usage;
    if (row.type === "assistant" && !row.isSidechain && usage)
      return usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  }
  return 0;
}

function decide(input: unknown, provider: "claude" | "codex") {
  const event = parseEvent(input);
  if (event.agent_id || (event.hook_event_name === "PreCompact" && event.trigger !== "auto")) return;
  const directory = join(homedir(), ".life-ai", "orchestrator-rotation");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(
    directory,
    `${createHash("sha256").update(`${provider}:${event.session_id}`).digest("hex")}.sqlite`,
  );
  const db = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
    db.exec(
      "PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS claims (event TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS registration (id INTEGER PRIMARY KEY CHECK(id=1), opted INTEGER NOT NULL); BEGIN IMMEDIATE",
    );
    // Only the first prompt decides; a session first seen later can never opt in.
    const first =
      event.hook_event_name === "UserPromptSubmit" && string(event.prompt).split(/\r?\n/).includes(marker) ? 1 : 0;
    db.prepare("INSERT OR IGNORE INTO registration(id,opted) VALUES (1,?)").run(first);
    const opted = db.prepare("SELECT opted FROM registration WHERE id=1").get()?.opted === 1;
    if (event.hook_event_name === "UserPromptSubmit" || !opted) {
      db.exec("COMMIT");
      return;
    }
    if (event.hook_event_name === "PreCompact") {
      db.prepare("INSERT OR IGNORE INTO claims(event) VALUES ('PreCompact')").run();
      db.exec("COMMIT");
      // Claude skips a blocked proactive compaction and carries on uncompacted.
      if (provider === "claude") return { decision: "block", reason: blocked };
      return;
    }
    const due =
      Boolean(db.prepare("SELECT event FROM claims WHERE event='PreCompact'").get()) ||
      (provider === "claude" && contextTokens(event.transcript_path) >= 350_000);
    const once = due && db.prepare("INSERT OR IGNORE INTO claims(event) VALUES ('Stop')").run().changes > 0;
    db.exec("COMMIT");
    if (once) return { decision: "block", reason: provider === "codex" ? `${codexHandoff}\n${handoff}` : handoff };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  let eventName: unknown;
  try {
    const provider = process.argv[2];
    if (provider !== "claude" && provider !== "codex") throw new Error("Unknown provider");
    const input = record(JSON.parse(readFileSync(0, "utf8")));
    eventName = input.hook_event_name;
    const result = decide(input, provider);
    if (result) process.stdout.write(JSON.stringify(result));
  } catch {
    process.stdout.write(
      JSON.stringify({
        systemMessage: `Life AI orchestrator hook failed at ${String(eventName)}. Registration or handoff was not confirmed. Check the checkout and private state before continuing.`,
      }),
    );
  }
}
