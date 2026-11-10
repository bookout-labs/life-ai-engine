# Life AI

Life AI is a personal and family operating system over agents in T3 Code.

Read personal context from Neon through node .agents/scripts/pages.ts list, read and search. Original files live in R2 through files.ts. Query members for family context; never embed personal facts in engine files.

Neon holds records and personal prose, R2 holds originals, this repository holds code and system procedures, and the Builds board holds build status. docs/architecture.md describes storage.

Use short, plain answers, visual explanations, existing tools and lean TypeScript. Platform features come first. Account tasks are ready plans with live walkthroughs. When writing TypeScript, read .agents/skills/lab/SKILL.md first. Before writing a page, read .agents/skills/wiki/SKILL.md.

.agents/skills is the canonical skill folder. .agents/skills/wiki owns knowledge maintenance; sunday owns family check-ins; lab owns building, research and tool choices. docs/skill-map.md is a catalog. Hooks deliver context on events; checks validate routes. .agents/rules.ts is the rule source and AGENTS.md is generated.

## Routed rules

- **instruction-paths**: Repository paths named in backticks in instructions, docs, skills and rules must exist. Trigger: npm run check. Route: check `.agents/scripts/instruction-paths.ts`.
- **rules**: Rules require a trigger and a hook or check route; AGENTS.md is generated. Trigger: npm run check. Route: check `.agents/scripts/rules.ts`.
- **instruction-writes**: Agents' normal edits to instruction files and agent memory are blocked: by permissions.deny in .claude/settings.json natively for Claude and Grok (shell included), and by this hook for every agent's file-edit tools. Other agents' shell and interpreter writes are out of scope; CI's AGENTS.md drift check is the wall. Add an entry in .agents/rules.ts with trigger and a hook or check route, then run node .agents/scripts/rules.ts --write. Trigger: instruction or memory write. Route: hook `.agents/hooks/rule-guard.ts` (PreToolUse).
- **save**: Raw git commit, git push and gh pr merge are blocked; save.ts owns saving. If save.ts fails partway, stop and ask the user. Claude blocks them natively with permissions.deny in .claude/settings.json; Codex through this hook. GitHub's protect-main ruleset and the gate are the wall. Trigger: shell save. Route: hook `.agents/hooks/guard.ts` (PreToolUse).
- **gate**: Code saves require an open board issue, production proof and current cross-family review; system saves require issue and review. Trigger: pull request. Route: check `.agents/scripts/gate.ts`.
- **evergreen**: Changing conditions and closed until-issue references fail the stale-rule check. Trigger: npm run check. Route: check `.agents/scripts/stale-rules.ts`.
- **orchestrator-registration**: Persist coordinator opt-in from the first native UserPromptSubmit prompt per provider session. Later prompts and workers cannot opt in. Trigger: first native user prompt. Route: hook `.agents/hooks/orchestrator-rotation.ts` (UserPromptSubmit).
- **orchestrator-rotation**: Only first-prompt opted-in orchestrators receive rotation instructions. Save private handoffs through pages.ts, recover active jobs without restarting them, and always launch the successor, pin it and unpin the retiring thread. Never archive the retiring thread. Trigger: coordinator stop. Route: hook `.agents/hooks/orchestrator-rotation.ts` (Stop).
- **orchestrator-compaction**: Coordinators hand off at 400k tokens, where each agent's automatic compaction fires (CLAUDE_CODE_AUTO_COMPACT_WINDOW, model_auto_compact_token_limit). Claude's compaction is blocked, so it hands off with the full context; Codex compacts once, then hands off from its messages, the summary and the program store. Manual compaction and workers remain unaffected. Trigger: automatic coordinator compaction. Route: hook `.agents/hooks/orchestrator-rotation.ts` (PreCompact).
- **codex-trust**: Approve only this repository's enabled Codex hooks before a Codex delegate starts, then verify trust. Trigger: Codex delegate_task. Route: hook `.agents/hooks/codex-trust.ts` (PreToolUse).
