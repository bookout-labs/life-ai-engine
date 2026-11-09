import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { renderHandoff } from "../scripts/handoff-input.ts";
import { array, boolean, integer, nonempty, optionalString, record, string } from "./parse.ts";

const marker = "Life-AI-Session-Role: orchestrator";
function parseEvent(input: unknown) {
  const event = record(input);
  const name = string(event.hook_event_name);
  if (!["UserPromptSubmit", "Stop", "PreCompact"].includes(name)) throw new Error("Unknown hook event");
  return {
    hook_event_name: name,
    session_id: nonempty(event.session_id),
    transcript_path: event.transcript_path == null ? undefined : nonempty(event.transcript_path),
    prompt: optionalString(event.prompt),
    agent_id: event.agent_id == null ? undefined : nonempty(event.agent_id),
    trigger: optionalString(event.trigger),
  };
}

function parseRow(input: unknown) {
  const row = record(input);
  const type = string(row.type);
  const sessionId = optionalString(row.sessionId);
  const isSidechain = row.isSidechain === undefined ? undefined : boolean(row.isSidechain);
  if (row.isMeta !== undefined) boolean(row.isMeta);
  let message: Record<string, unknown> | undefined;
  if (row.message !== undefined) {
    message = record(row.message);
    if (message.content !== undefined && typeof message.content !== "string") {
      for (const part of array(message.content)) {
        const content = record(part);
        string(content.type);
        optionalString(content.text);
      }
    }
  }
  if (row.payload !== undefined) {
    const payload = record(row.payload);
    for (const key of ["type", "message", "id"]) optionalString(payload[key]);
  }
  return { type, sessionId, isSidechain, message };
}

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

function latestUsage(path: string, session: string) {
  let latest: unknown;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = parseRow(JSON.parse(line));
    if (row.sessionId !== undefined && row.sessionId !== session) continue;
    if (row.isSidechain) continue;
    if (row.type === "assistant") latest = row.message?.usage;
  }
  if (latest === undefined) return 0;
  const usage = record(latest);
  return (
    integer(usage.input_tokens) + integer(usage.cache_read_input_tokens) + integer(usage.cache_creation_input_tokens)
  );
}

function validateCheckpoint(input: unknown) {
  const value = record(input);
  if (value.schema !== "orchestrator-store-snapshot/v1") throw new Error("Invalid snapshot schema");
  const files = Object.fromEntries(Object.entries(record(value.files)).map(([name, text]) => [name, string(text)]));
  for (const name of ["preferences.md", "agents.json", "current-handoff-input.json", "current-handoff-slug.txt"])
    nonempty(files[name]);
  if (!/^handoff\/[^\s]+\s*$/.test(files["current-handoff-slug.txt"] ?? "")) throw new Error("Invalid handoff slug");
  const snapshot = { schema: value.schema, programStore: string(value.programStore), files };
  for (const job of Object.values(record(JSON.parse(nonempty(files["agents.json"]))))) nonempty(record(job).taskId);
  renderHandoff(JSON.parse(nonempty(snapshot.files["current-handoff-input.json"])));
  return snapshot;
}

function checkpoint(directory: string) {
  const programStore = join(homedir(), ".life-ai", "orchestrate", "life-ai-builds");
  let bytes = 0;
  const files: Record<string, string> = {};
  for (const entry of readdirSync(programStore, { recursive: true, withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Store checkpoint cannot follow symbolic links");
    if (!entry.isFile()) continue;
    const source = join(entry.parentPath, entry.name);
    const data = readFileSync(source);
    bytes += data.length;
    if (data.length > 8 * 1024 * 1024 || bytes > 32 * 1024 * 1024) throw new Error("Store exceeds checkpoint limit");
    const text = data.toString("utf8");
    if (!Buffer.from(text).equals(data)) throw new Error("Store checkpoint requires lossless UTF-8 files");
    files[relative(programStore, source)] = text;
  }
  const body = JSON.stringify(validateCheckpoint({ schema: "orchestrator-store-snapshot/v1", programStore, files }));
  const sha256 = createHash("sha256").update(body).digest("hex");
  const path = join(directory, `${sha256}.json`);
  const temporary = join(directory, `${randomUUID()}.tmp`);
  writeFileSync(temporary, body, { flag: "wx", mode: 0o600, flush: true });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  if (readFileSync(path, "utf8") !== body) throw new Error("Checkpoint readback differs");
  return path;
}

function recovery(path: string) {
  const text = `Private store snapshot: ${path}.
Restore through bounded capture with pipefail enabled:
node .agents/hooks/orchestrator-rotation.ts read-checkpoint '${path}' --full | node .agents/scripts/handoff.ts capture.
If capture returns a private receipt, inspect only the sections needed for recovery.
This preserves the program store, preferences standing orders, current recovery slug,
all stored task ids and reporting destinations. It is NOT live T3 status.
Reconcile known completion events with the coordinator. Never restart jobs from stored running status.
Preserve EVERY task id, report destination, standing-order reference and current recovery slug
known in this conversation in the summary, including updates absent from the store.
No launch, archive or pin authority is granted. Read docs/orchestrator-handoff.md.`;
  if (Buffer.byteLength(text) > 2000) throw new Error("Recovery instructions exceed header bound");
  return text;
}

function decide(input: unknown, provider: "claude" | "codex") {
  const event = parseEvent(input);
  if (event.agent_id || (event.hook_event_name === "PreCompact" && event.trigger !== "auto")) return;
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
    db.exec(
      "PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS claims (event TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS registration (id INTEGER PRIMARY KEY CHECK(id=1), opted INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS preservation (id INTEGER PRIMARY KEY CHECK(id=1), path TEXT NOT NULL); BEGIN IMMEDIATE",
    );
    if (event.hook_event_name === "UserPromptSubmit") {
      const prompt = string(event.prompt);
      db.prepare("INSERT OR IGNORE INTO registration(id,opted) VALUES (1,?)").run(
        Number(prompt.split(/\r?\n/).includes(marker)),
      );
      db.exec("COMMIT");
      const saved = db.prepare("SELECT path FROM preservation WHERE id=1").get();
      if (saved) return recovery(string(saved.path));
      return;
    }
    // A session first seen after prompt submission cannot opt in later.
    db.prepare("INSERT OR IGNORE INTO registration(id,opted) VALUES (1,0)").run();
    const opted = db.prepare("SELECT opted FROM registration WHERE id=1").get();
    if (opted?.opted !== 1) {
      db.exec("COMMIT");
      return;
    }
    const compact = event.hook_event_name === "PreCompact";
    if (compact) {
      if (provider === "claude") {
        db.prepare("INSERT OR IGNORE INTO claims(event) VALUES ('PreCompact')").run();
        db.exec("COMMIT");
        return `Preserve private program store ~/.life-ai/orchestrate/life-ai-builds and its preferences.md standing orders,
current-handoff-slug.txt recovery slug, and EVERY known active task id, reporting destination
and report path in the summary. Include current conversation updates and current handoff slug.
The store agents.json contains dispatch snapshots, NOT live task status.
Restore the standing orders and recovery packet before acting. Reconcile completion events with
the coordinator. Never restart existing jobs. No launch, archive or pin authority is granted.
Read docs/orchestrator-handoff.md. Preserve private references without exposing their contents.`;
      }
      const saved = checkpoint(directory);
      db.prepare("INSERT OR REPLACE INTO preservation(id,path) VALUES (1,?)").run(saved);
      db.prepare("INSERT OR IGNORE INTO claims(event) VALUES ('PreCompact')").run();
      db.exec("COMMIT");
      return { continue: true, systemMessage: recovery(saved) };
    }
    const tokens =
      provider === "claude" && event.transcript_path ? latestUsage(event.transcript_path, event.session_id) : 0;
    const guarded = Boolean(db.prepare("SELECT event FROM claims WHERE event='PreCompact'").get());
    if (!guarded) {
      const threshold =
        process.env.LIFE_AI_ROTATION_TOKENS === undefined
          ? undefined
          : integer(Number(process.env.LIFE_AI_ROTATION_TOKENS), 1);
      if (provider === "codex" || threshold === undefined || !event.transcript_path || tokens < threshold) {
        db.exec("COMMIT");
        return;
      }
    }
    const result = db.prepare("INSERT OR IGNORE INTO claims(event) VALUES ('Stop')").run();
    const saved = db.prepare("SELECT path FROM preservation WHERE id=1").get();
    db.exec("COMMIT");
    if (!result.changes) return;
    return { decision: "block", reason: saved ? `${recovery(string(saved.path))}\n${handoff}` : handoff };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  let eventName: unknown;
  try {
    if (process.argv[2] === "read-checkpoint") {
      const path = string(process.argv[3]);
      const body = readFileSync(path, "utf8");
      const snapshot = validateCheckpoint(JSON.parse(body));
      if (!path.endsWith(`${createHash("sha256").update(body).digest("hex")}.json`))
        throw new Error("Checkpoint checksum differs");
      process.stdout.write(process.argv.includes("--full") ? JSON.stringify(snapshot) : recovery(path));
      process.exit(0);
    }
    const provider = process.argv[2];
    if (provider !== "claude" && provider !== "codex") throw new Error("Unknown provider");
    const input = record(JSON.parse(readFileSync(0, "utf8")));
    eventName = input.hook_event_name;
    const result = decide(input, provider);
    if (result) process.stdout.write(typeof result === "string" ? result : JSON.stringify(result));
  } catch {
    if (process.argv[2] === "read-checkpoint") {
      process.stderr.write("Checkpoint recovery failed validation.\n");
      process.exitCode = 1;
    } else {
      process.stdout.write(
        JSON.stringify({
          systemMessage:
            eventName === "PreCompact"
              ? "Life AI continuity preservation failed. Check the checkout and private state before continuing."
              : "Life AI orchestrator hook failed. Registration or continuity preservation was not confirmed. Check the checkout and private state before continuing.",
        }),
      );
    }
  }
}
