# Recover an orchestrator

Opt in only a coordinator by putting this exact line in its first real user prompt.

```text
Life-AI-Session-Role: orchestrator
```

Worker prompts must omit the line. A later prompt cannot opt a session in. A provider session id is not a T3 thread id.

## Prepare the handoff

1. Reconcile the live T3 task inventory with the private program store at ~/.life-ai/orchestrate/life-ai-builds. Include every running task, its id, its reporting destination and its report path. Preserve native jobs, delegated jobs and scheduled work. Hook transcript usage cannot establish this inventory.
2. Prepare JSON outside git with the shape below. Put personal prose in this input only. Use private files or R2 for large artifacts, and include their receipts in state. Use a unique handoff slug for this retiring seat.
3. Run `node .agents/scripts/handoff.ts validate` with that JSON on stdin. It returns the header or fails if required fields are missing, task ids repeat, or the header exceeds 2,000 UTF-8 bytes.
4. Run `node .agents/scripts/handoff.ts write handoff/<unique-slug>` with the same JSON on stdin. It writes through pages.ts to Neon, reads back the exact body, and returns only the slug, byte count and SHA256. Storage errors fail visibly. Do not place input prose in shell arguments, logs, PRs or engine files.
5. Run `node .agents/scripts/handoff.ts read handoff/<unique-slug>` to read the header first. Run the same command with `--full` to recover standing orders, state and jobs. The reader validates that the header matches the detailed body.

The input shape uses synthetic values here.

```json
{
  "header": {
    "status": "rotation ready",
    "retiringThreadId": "synthetic-t3-thread",
    "blockers": [],
    "nextAction": "Inspect the existing task",
    "detailPaths": ["private-state-path"],
    "jobReportPaths": ["private-report-path"]
  },
  "standingOrders": "Restore the private standing orders before acting.",
  "programStore": "private-program-store-path",
  "state": "Exact branches, PRs, decisions, blockers, next actions and artifact receipts.",
  "jobs": [
    {
      "taskId": "synthetic-task",
      "reportingTo": "synthetic-reporting-thread-link",
      "reportPath": "private-report-path",
      "status": "running"
    }
  ]
}
```

## Resume without restarting jobs

Start the successor with poteto-mode Orchestrate and Session pickup. Include the retiring T3 thread id, the recovery slug and the opt-in line in an authorized successor prompt. Restore the standing orders and program store. Inspect existing tasks by id and preserve their reporting destinations. Do not recreate active work because a new coordinator owns the handoff.

Launch a new top-level T3 thread only when current user/session authorization permits this successor. A hook threshold supplies no authorization. Otherwise resume the existing coordinator using the verified handoff. Neither seat archives the retiring thread. Pins stay unchanged unless explicit prior authority permits a change.

## Capture bootstrap output

Use a shell pipeline with pipefail so upstream failures stay visible.

```sh
set -o pipefail
<bootstrap-command> | node .agents/scripts/handoff.ts capture
```

Capture streams bytes to an exclusive mode-0600 file under ~/.life-ai/handoffs/bootstrap. Memory use is bounded by a 65,536-byte chunk. Output through exactly 40,000 bytes returns unchanged and deletes the capture file. Larger output returns an absolute private path, bytes and SHA256. Unicode limits count encoded bytes. The receipt is local to this machine. Upload large artifacts through files.ts to private R2 when another machine needs durable recovery. Required source reads still apply.

## Native hook support

The [Claude hooks reference](https://code.claude.com/docs/en/hooks#precompact) supports Stop decisions and PreCompact blocking. The [Codex hooks reference](https://learn.chatgpt.com/docs/hooks#precompact) uses `continue: false` for PreCompact. Both configurations retain the existing hooks and add the automatic-compaction matcher. The TypeScript hook never invokes T3 tools, changes pins or launches a thread.

Claude Stop uses the latest assistant input, cache-read and cache-creation counters from the marked session. It ignores output tokens and accumulated spend. LIFE_AI_ROTATION_TOKENS must explicitly name a positive model-appropriate threshold. There is no copied 500,000-token default or 700,000-token compaction window. Choose a threshold below the active model's verified automatic-compaction window before starting the coordinator. Without a threshold, the automatic-compaction guard still works.

Codex identification reads its session_meta id and first event_msg user_message. Proactive Codex token-based rotation is unsupported in this change. It does not reinterpret Claude counters or cumulative Codex telemetry. Codex automatic PreCompact stops before compaction, rather than guaranteeing an immediate model turn to write prose. Resume that coordinator to prepare the handoff, or recover a handoff prepared earlier. A subsequent Stop provides the recovery instruction once.

A private SQLite database per provider session serializes Stop and PreCompact claims across processes. SQLite releases locks after a process exits. Each event instructs once, including replay. An automatic guard makes the next Stop eligible even below the threshold. Missing or malformed input, transcript, usage or state fails open. Automatic guards are one-shot, not a promise to prevent every later compaction. In Claude, blocking compaction after an API context-limit error can expose the underlying error. Prepare handoffs before that boundary.

## Design and verification

The design considered a direct Python port with flock and a TypeScript hook with per-session SQLite transactions. The TypeScript module keeps transcript validation and the two-event claim state behind the hook process interface. SQLite supplies native process locks and crash release without a custom lock-expiration protocol. The separate handoff command owns bounded capture and the Neon write/read interface. Personal state never enters the claim database.

Tests exercise the actual hook and CLI processes, threshold boundaries, latest usage, worker exclusion, session identity, compaction triggers, replay, parallel processes, corrupt inputs, capture bytes and checksums, file permissions and bounded headers. Run `node --test .agents/hooks/orchestrator-rotation.test.ts .agents/scripts/handoff.test.ts` and `npm run check`.

Local inspection found Claude Code 2.1.319 and Codex CLI 0.167.0. T3 reports thread management and delegated-task capabilities. These observations do not prove native dispatch. A synthetic Neon write/read proves private storage recovery only. Coordinator acceptance still requires an opted-in native session to trigger the installed hooks and a successor or resumed coordinator to recover the live job inventory without restarting work. The coordinator owns independent review, that integration run and board closure.
