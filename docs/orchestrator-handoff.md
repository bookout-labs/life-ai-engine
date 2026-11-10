# Recover an orchestrator

Opt in only a coordinator by putting this exact line in its first real user prompt.

```text
Life-AI-Session-Role: orchestrator
```

Worker prompts must omit the line. A later prompt cannot opt a session in. A provider session id is not a T3 thread id.

## Prepare the handoff

1. Reconcile the live T3 task inventory with the private program store at ~/.life-ai/orchestrate/life-ai-builds. Include every running task, its id, its reporting destination and its report path. Preserve native jobs, delegated jobs and scheduled work. Hook transcript usage cannot establish this inventory.
2. Prepare JSON outside git with the shape below. Put personal prose in this input only. Use private files or R2 for large artifacts, and include their receipts in state. Use a unique handoff slug for this retiring seat.
3. Run `node .agents/scripts/handoff.ts write handoff/<unique-slug>` with that JSON on stdin. It checks the packet first: required fields, unique task ids and a header of at most 2,000 UTF-8 bytes. It creates the Neon page through the core pages API with an expected empty revision. A reused slug is refused atomically. It reads back the exact body and returns only the slug and byte count. Storage errors fail visibly. Do not place input prose in shell arguments, logs, PRs or engine files.
4. Run `node .agents/scripts/handoff.ts read handoff/<unique-slug>` to read the header first. Run the same command with `--full` to recover standing orders, state and jobs. The reader validates that the header matches the detailed body.

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

Start the successor with poteto-mode Orchestrate and Session pickup. Include the retiring T3 thread id, the recovery slug and the opt-in line in the successor prompt. Restore the standing orders and program store. Inspect existing tasks by id and preserve their reporting destinations. Do not recreate active work because a new coordinator owns the handoff.

Always launch the successor as a new top-level T3 thread, pin it and unpin the retiring thread. Neither seat archives the retiring thread. Post the successor's link.

## Native hook support

Both configurations register UserPromptSubmit, Stop and automatic PreCompact. The first native prompt fixes opt-in in a private SQLite registration keyed by provider and session_id. Both positive and negative decisions persist, later prompts cannot change them, and hooks with agent_id never touch parent-session state. Enable and trust the hooks before the session's first prompt.

Coordinators hand off at 400k tokens, where each agent's automatic compaction fires: `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in `.claude/settings.json` and `model_auto_compact_token_limit` in `.codex/config.toml`. The agents count their own tokens; the hook never reads transcripts.

Claude: a blocked proactive compaction is skipped and the conversation continues uncompacted ([PreCompact](https://code.claude.com/docs/en/hooks#precompact)). The hook blocks it for a coordinator, and the next Stop asks for the handoff while the full context is still there.

Codex: blocking compaction interrupts the turn, and every later turn hits the limit again before the model can act, so the coordinator wedges (#145, live test). A custom `compact_prompt` is ignored by Codex's server-side compaction. So Codex compacts once, and the hook asks for the handoff at that turn's Stop. Codex keeps every user message; the rest comes from its compacted summary and the program store on disk.

The Stop handoff is delivered at most once per session. Manual compaction is untouched on both providers. Malformed input or state produces a visible warning and never claims registration or handoff.

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

The agents count tokens themselves through their automatic-compaction settings, so the hook reads no transcripts. SQLite keeps session identity, first-prompt decisions and the compaction and Stop claims together behind the process interface. Provider session ids never stand in for T3 thread ids.

Process fixtures cover first-negative then later-positive prompts, worker exclusion, replay, concurrent claims, and automatic and manual compaction on both providers. Run `node --test .agents/hooks/orchestrator-rotation.test.ts .agents/scripts/handoff.test.ts` and `npm run check`.

Official docs and installed schemas establish supported input and output contracts. Synthetic process fixtures do not prove native hook dispatch, summary fidelity or live T3 recovery. Coordinator acceptance still requires a newly authorized or restarted opted-in session with hooks trusted and loaded before its first prompt. Observe automatic preservation and recovery without restarting any active job. The coordinator owns independent cross-family review, that integration run and board closure.

Hooks run without node_modules so the first native UserPromptSubmit can register before dependency installation. A hook failure produces a visible warning without claiming registration or handoff. Lint findings are reported as findings; an unavailable Biome is reported as an inability to verify.

Run `node --test .agents/hooks/fresh-worktree.test.ts` before installing dependencies. The fixture copies current hook and script sources into a checkout without node_modules, checks that every hook runs and each guard denies, and verifies native prompt registration and each provider's automatic-compaction response from a synthetic HOME. Set HOOK_REPRO_REF to a prior Git revision to run the same assertions against its archived sources. These synthetic checks do not replace the coordinator's native acceptance.
