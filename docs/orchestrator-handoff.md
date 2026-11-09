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
4. Run `node .agents/scripts/handoff.ts write handoff/<unique-slug>` with the same JSON on stdin. It creates the Neon page through the core pages API with an expected empty revision. A reused slug is refused atomically. It reads back the exact body and returns only the slug, byte count and SHA256. Storage errors fail visibly. Do not place input prose in shell arguments, logs, PRs or engine files.
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

Both configurations register UserPromptSubmit alongside the existing Stop and automatic PreCompact hooks. The first native prompt field fixes opt-in in a private SQLite registration keyed by provider and session_id. Both positive and negative decisions persist. Later prompts cannot change the decision. Hooks with agent_id are excluded before accessing parent-session state. A transcript marker cannot register a coordinator. Sessions first observed at Stop or PreCompact are registered as ineligible. Enable and trust the hooks before the session's first prompt. Existing sessions cannot establish their original first prompt retroactively. Replayed prompt events retain the original decision. Concurrent prompt registration uses SQLite arrival order, so native prompt dispatch must preserve submission order.

The [Claude hooks reference](https://code.claude.com/docs/en/hooks#precompact-output) documents successful PreCompact stdout as instructions for the compaction summary. This hook emits bounded preservation instructions on every automatic compaction, including retries. It tells the summarizer to retain private program-store and preferences.md standing-order references, the current recovery slug, every known active task id, reporting destination and report path, and updates from the conversation. It does not block or require a model tool turn before compaction. Summary fidelity still needs native acceptance proof.

Claude Stop uses the latest assistant input, cache-read and cache-creation counters, ignoring output tokens and accumulated spend. LIFE_AI_ROTATION_TOKENS must explicitly name a positive model-appropriate threshold below the active model's verified automatic-compaction window. There is no default threshold. Proactive Stop usage parsing fails open on malformed transcript rows. Automatic compaction preservation does not read the transcript. Missing or null transcripts are accepted by the native event parser. Without a transcript, proactive usage rotation is unavailable but automatic preservation still works.

The [Codex hooks reference](https://learn.chatgpt.com/docs/hooks#precompact) documents nullable transcript_path and warns that transcript rows are unstable. Codex opt-in uses only UserPromptSubmit.prompt and session_id. Proactive Codex token rotation remains unsupported. Installed Codex 0.167.0 embeds a PreCompact output schema with continue, stopReason, suppressOutput and systemMessage only. Plain stdout is ignored. systemMessage is a UI warning, not model context. A one-shot block cannot provide durable recovery.

Before allowing Codex automatic compaction, the hook writes a deterministic, validated private store checkpoint. Existing pstack files and handoff.ts require a model to prepare or update them. Neither can capture native event state by itself. The small checkpoint implementation therefore lives inside the rotation hook. It copies every UTF-8 file in the private program store, including nested briefs and report references, preferences.md standing orders, agents.json dispatch records, current-handoff-input.json and current-handoff-slug.txt. Symbolic links are rejected. Every stored task id and reporting destination is preserved byte-for-byte, including records newer than the handoff packet. The handoff input must pass the existing handoff.ts validator, including its 2,000-byte header limit. Each source file is limited to 8 MiB and the complete source snapshot to 32 MiB. The hook atomically publishes a content-addressed mode-0600 file, verifies readback, and commits its pointer before returning success. The directory is mode 0700. Output contains only bounded recovery instructions and a private path.

This is a store snapshot, not live T3 inventory or an update to Neon. Stored running statuses can be stale. The coordinator alone reconciles known completion events. The hook cannot preserve facts missing from both the store and an earlier private handoff. Keep the store and handoff input current before compaction. Snapshot reads across files are not a transactional view of concurrent store edits. Known work or report destinations absent from the store remain unavailable to the hook. The hook does not poll, restart, launch, archive or pin any task or thread.

To recover a Codex checkpoint, copy the absolute checkpoint path from the native UI receipt or the next UserPromptSubmit recovery instruction. Run `node .agents/hooks/orchestrator-rotation.ts read-checkpoint <absolute-private-path>` for bounded restoration instructions. To read the complete checksum-validated snapshot, enable pipefail and pipe `node .agents/hooks/orchestrator-rotation.ts read-checkpoint <absolute-private-path> --full` through `node .agents/scripts/handoff.ts capture`. Inspect only needed sections if capture returns a receipt. Restore its standing orders and recovery slug, then read the Neon handoff through handoff.ts. Preserve every stored task id and reporting destination. Reconcile completion events before acting and never recreate work based on stored running status. Keep full recovery output private.

Codex PreCompact returns continue true only after the checkpoint and session pointer are written. Stop later supplies the existing handoff instruction once. The next submitted prompt supplies the recovery path as documented developer context. Immediate automatic injection into the post-compaction model context is unsupported. Recovery requires the subsequent Stop, submitted prompt or an operator using the recorded receipt. No parity with Claude summarizer instructions is claimed. Manual compaction is untouched on both providers.

SQLite serializes registration and claims across processes and releases locks when a process exits. Stop delivery is at most once. A crash after committing its claim but before stdout may lose that instruction. Automatic preservation is repeatable and does not spend a one-shot guard. Failed checkpoint validation, corrupt state and malformed native input fail open. A failed checkpoint therefore provides no preservation guarantee. Recovery commands fail visibly. Atomic publication can leave private orphan .tmp files after a crash, but retries publish a fresh complete checkpoint.

## Establish Codex hook trust

The [Codex hooks reference](https://learn.chatgpt.com/docs/hooks) describes **Review hooks** in the desktop composer and **Settings > Hooks**. Review, enable, and trust the hooks before a top-level coordinator's first prompt. The delegate preflight cannot establish trust for an already running coordinator.

Linked Git worktrees load project hook declarations from the primary checkout's matching .codex directory. They share that source path and its trust keys. Ordinary worktree configuration can still differ. The merged Codex PR states this resolution rule in [PR #21969](https://github.com/openai/codex/pull/21969). A read-only hooks/list probe against installed Codex 0.167.0 confirmed primary-checkout source paths for this repository's T3 worktrees. Commands that use git rev-parse still locate scripts in the active worktree. Updating those scripts alone cannot add event declarations to the primary checkout.

The codex-trust preflight resolves the primary checkout from Git's worktree inventory and reads its hook declarations. It checks that hooks/list contains every declared command hook under the expected primary-source key. Missing declarations, empty or malformed discovery, disabled hooks, and unverified trust deny delegate start visibly. It approves only this repository's enabled hooks through app-server config/value/write when the primary hooks.json bytes equal the fetched origin/main blob. pull.ts already fetches origin main. Worktree equality alone never establishes provenance. Other sources receive no approval. Disabled repository hooks remain disabled. Immediately before writing trust it rechecks the primary bytes against the provenance snapshot. After approval it lists hooks again and verifies both trust and the approved hashes. Discovery, configuration reads and trust writes are not atomic, so a concurrent edit can still occur between checks or after verification. Never edit global trusted hashes by hand.

The user's 2026-11-07 authority covers approval of this repository's enabled hooks. Because Codex shares the primary source, approval affects every Codex session using that checkout, including linked worktrees. It does not create per-worktree trust or pin the contents of scripts called by a trusted command. Keep independent review of hook scripts and save gates intact.

After the reviewed patch and rotation declarations merge, complete these steps before native acceptance.

1. Inspect the primary checkout's branch and working status. With a clean main checkout, run `git -C <primary> pull --ff-only` for the primary checkout. Preserve local work if Git refuses. Reconcile the worker's hooks.json with merged main rather than copying unmerged declarations into the primary checkout. Updating main changes declarations for all its Codex worktrees. A later reviewed revert can restore the previous declarations.
2. Review the resolved primary-source hooks in Codex **Settings > Hooks**. Enable and approve the intended entries through the native UI. A subsequent Codex delegation preflight can approve enabled repository entries through the app-server under the existing authority. Disable or revoke approval through the same UI to reverse trust. Do not restore trusted hashes manually.
3. Run a read-only app-server hooks/list probe with cwds containing the target T3 worktree. Require the rotation UserPromptSubmit, Stop, and automatic PreCompact entries under the primary source, all enabled and trusted. This probe writes no configuration.
4. Start a fresh authorized session after approval. Verify native registration and automatic compaction recovery while preserving active jobs. Existing sessions cannot recover their original first-prompt registration retroactively. The coordinator owns this native proof and board closure.

A primary config that differs from fetched origin/main receives no new approval. If its existing declared hooks are enabled and trusted, delegation proceeds with a warning even when primary and worktree declarations differ. Hooks declared on main but missing from the primary, such as rotation, are inactive. The warning names the primary-checkout update command. Per the [Claude Code hooks reference](https://code.claude.com/docs/en/hooks#json-output), systemMessage displays the warning to the user. The same warning uses hookSpecificOutput.additionalContext to reach Claude's model context through PreToolUse. It omits permissionDecision so normal permission handling continues. This check runs before a Codex delegate starts. Top-level sessions still require native review before their first prompt.

## Design and verification

Two designs were considered. Transcript adapters plus one-shot blocking depend on unstable rollout rows and cannot force a pre-compaction model turn. Durable native prompt registration plus provider-specific preservation uses documented event fields and preserves existing capture and Neon contracts. SQLite keeps session identity, first-prompt decisions, checkpoint pointers and Stop claims together behind the process interface. Provider session ids never stand in for T3 thread ids.

Process fixtures cover first-negative then later-positive prompts, worker exclusion, absent and null transcripts, replay, concurrent claims, latest usage, automatic and manual compaction, repeatable summary instructions, checkpoint readback, checksums and private permissions. Run `node --test .agents/hooks/orchestrator-rotation.test.ts .agents/scripts/handoff.test.ts` and `npm run check`.

Official docs and installed schemas establish supported input and output contracts. Synthetic process fixtures do not prove native hook dispatch, summary fidelity or live T3 recovery. Coordinator acceptance still requires a newly authorized or restarted opted-in session with hooks trusted and loaded before its first prompt. Observe automatic preservation and recovery without restarting any active job. The coordinator owns independent cross-family review, that integration run and board closure.
