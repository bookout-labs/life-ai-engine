# Life AI

Life AI is a personal and family operating system over agents in T3 Code.

Read personal context from Neon through node .agents/scripts/pages.ts list, read and search. Original files live in R2 through files.ts. Query members for family context; never embed personal facts in engine files.

Neon holds records and personal prose, R2 holds originals, this repository holds code and system procedures, and the Builds board holds build status. docs/architecture.md describes storage.

Use short, plain answers, visual explanations, existing tools and lean TypeScript. Platform features come first. Account tasks are ready plans with live walkthroughs.

.claude/skills/wiki owns knowledge maintenance; sunday owns family check-ins; lab owns building, research and tool choices. docs/skill-map.md is a catalog. Hooks deliver context on events; checks validate routes. .agents/rules.ts is the rule source and AGENTS.md is generated.

## Routed rules

- **instruction-paths**: Repository paths named in backticks in instructions, docs, skills and rules must exist. Trigger: npm run check. Route: check `.agents/scripts/instruction-paths.ts`.
- **rules**: Rules require a trigger and a hook or check route; AGENTS.md is generated. Trigger: npm run check. Route: check `.agents/scripts/rules.ts`.
- **instruction-writes**: Direct writes to generated instructions and agent memory are blocked. Add an entry in .agents/rules.ts with trigger and a hook or check route, then run node .agents/scripts/rules.ts --write. Trigger: instruction or memory write. Route: hook `.agents/hooks/rule-guard.ts` (PreToolUse).
- **save**: Raw git commit, git push and gh pr merge are blocked; save.ts owns saving. Trigger: shell save. Route: hook `.agents/hooks/guard.ts` (PreToolUse).
- **unsaved**: The next prompt receives a reminder of unchanged files left unsaved. Trigger: user prompt. Route: hook `.agents/hooks/turn-start.ts` (UserPromptSubmit).
- **snapshot**: Track changes left unsaved at the end of a reply. Trigger: reply ends. Route: hook `.agents/hooks/stop-check.ts` (Stop).
- **gate**: Code saves require an open board issue, production proof and current cross-family review; system saves require issue and review. Trigger: pull request. Route: check `.agents/scripts/gate.ts`.
- **evergreen**: Changing conditions and closed until-issue references fail the stale-rule check. Trigger: npm run check. Route: check `.agents/scripts/stale-rules.ts`.
- **code-context**: Deliver lean-code and build guidance when TypeScript is edited. Trigger: TypeScript edit. Route: hook `.agents/hooks/code-rules.ts` (PreToolUse).
- **wiki-context**: Deliver wiki maintenance guidance on scratch-page edits and pages.ts write or save. Trigger: scratch-page edit or pages.ts write/save. Route: hook `.agents/hooks/code-rules.ts` (PreToolUse).
- **codex-trust**: Approve only this repository's enabled Codex hooks before a Codex delegate starts, then verify trust. Trigger: Codex delegate_task. Route: hook `.agents/hooks/codex-trust.ts` (PreToolUse).
