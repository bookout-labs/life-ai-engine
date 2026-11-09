type Route =
  | {
      kind: "hook";
      file: `.agents/${string}.ts`;
      event: "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop" | "PreCompact";
      // Tool names differ per agent; the check proves each config's matcher fires on these.
      tools: { claude: string[]; codex: string[] };
    }
  | { kind: "check"; file: `.agents/${string}.ts` };

export type Rule = { id: string; rule: string; trigger: string; route: Route; inject?: string; context?: string };

export const MAP = `Life AI is a personal and family operating system over agents in T3 Code.

Read personal context from Neon through node .agents/scripts/pages.ts list, read and search. Original files live in R2 through files.ts. Query members for family context; never embed personal facts in engine files.

Neon holds records and personal prose, R2 holds originals, this repository holds code and system procedures, and the Builds board holds build status. docs/architecture.md describes storage.

Use short, plain answers, visual explanations, existing tools and lean TypeScript. Platform features come first. Account tasks are ready plans with live walkthroughs.

.claude/skills/wiki owns knowledge maintenance; sunday owns family check-ins; lab owns building, research and tool choices. docs/skill-map.md is a catalog. Hooks deliver context on events; checks validate routes. .agents/rules.ts is the rule source and AGENTS.md is generated.`;

export const RULES: Rule[] = [
  {
    id: "instruction-paths",
    rule: "Repository paths named in backticks in instructions, docs, skills and rules must exist.",
    trigger: "npm run check",
    route: { kind: "check", file: ".agents/scripts/instruction-paths.ts" },
  },
  {
    id: "rules",
    rule: "Rules require a trigger and a hook or check route; AGENTS.md is generated.",
    trigger: "npm run check",
    route: { kind: "check", file: ".agents/scripts/rules.ts" },
  },
  {
    id: "instruction-writes",
    rule: "Direct writes to generated instructions and agent memory are blocked. Add an entry in .agents/rules.ts with trigger and a hook or check route, then run node .agents/scripts/rules.ts --write.",
    trigger: "instruction or memory write",
    route: {
      kind: "hook",
      file: ".agents/hooks/rule-guard.ts",
      event: "PreToolUse",
      tools: { claude: ["Write", "Edit", "MultiEdit", "Bash"], codex: ["apply_patch", "Bash"] },
    },
  },
  {
    id: "save",
    rule: "Raw git commit, git push and gh pr merge are blocked; save.ts owns saving.",
    trigger: "shell save",
    route: {
      kind: "hook",
      file: ".agents/hooks/guard.ts",
      event: "PreToolUse",
      tools: { claude: ["Bash"], codex: ["Bash"] },
    },
  },
  {
    id: "unsaved",
    rule: "The next prompt receives a reminder of unchanged files left unsaved.",
    trigger: "user prompt",
    route: {
      kind: "hook",
      file: ".agents/hooks/turn-start.ts",
      event: "UserPromptSubmit",
      tools: { claude: [], codex: [] },
    },
  },
  {
    id: "snapshot",
    rule: "Track changes left unsaved at the end of a reply.",
    trigger: "reply ends",
    route: { kind: "hook", file: ".agents/hooks/stop-check.ts", event: "Stop", tools: { claude: [], codex: [] } },
  },
  {
    id: "gate",
    rule: "Code saves require an open board issue, production proof and current cross-family review; system saves require issue and review.",
    trigger: "pull request",
    route: { kind: "check", file: ".agents/scripts/gate.ts" },
  },
  {
    id: "evergreen",
    rule: "Changing conditions and closed until-issue references fail the stale-rule check.",
    trigger: "npm run check",
    route: { kind: "check", file: ".agents/scripts/stale-rules.ts" },
  },
  {
    id: "code-context",
    rule: "Deliver lean-code and build guidance when TypeScript is edited.",
    trigger: "TypeScript edit",
    route: {
      kind: "hook",
      file: ".agents/hooks/code-rules.ts",
      event: "PreToolUse",
      tools: { claude: ["Edit", "Write"], codex: ["apply_patch"] },
    },
    inject: "**/*.ts",
    context: ".claude/skills/lab/SKILL.md",
  },
  {
    id: "wiki-context",
    rule: "Deliver wiki maintenance guidance on scratch-page edits and pages.ts write or save.",
    trigger: "scratch-page edit or pages.ts write/save",
    route: {
      kind: "hook",
      file: ".agents/hooks/code-rules.ts",
      event: "PreToolUse",
      tools: { claude: ["Edit", "Write", "Bash"], codex: ["apply_patch", "Bash", "exec_command"] },
    },
    inject: "~/.life-ai/pages/**/*.md",
    context: ".claude/skills/wiki/SKILL.md",
  },
  {
    id: "orchestrator-rotation",
    rule: "Only first-prompt opted-in orchestrators receive rotation instructions. Save private handoffs through pages.ts, recover active jobs without restarting them, and launch successors only with current user/session authority. Leave pins and retiring threads unchanged.",
    trigger: "coordinator stop",
    route: {
      kind: "hook",
      file: ".agents/hooks/orchestrator-rotation.ts",
      event: "Stop",
      tools: { claude: [], codex: [] },
    },
  },
  {
    id: "orchestrator-compaction",
    rule: "Guard automatic coordinator compaction once per provider session; manual compaction and workers remain unaffected. Model-specific proactive thresholds require explicit configuration.",
    trigger: "automatic coordinator compaction",
    route: {
      kind: "hook",
      file: ".agents/hooks/orchestrator-rotation.ts",
      event: "PreCompact",
      tools: { claude: [], codex: [] },
    },
  },
  {
    id: "codex-trust",
    rule: "Approve only this repository's enabled Codex hooks before a Codex delegate starts, then verify trust.",
    trigger: "Codex delegate_task",
    route: {
      kind: "hook",
      file: ".agents/hooks/codex-trust.ts",
      event: "PreToolUse",
      tools: { claude: ["mcp__t3-code__delegate_task"], codex: ["mcp__t3-code__delegate_task"] },
    },
  },
];
