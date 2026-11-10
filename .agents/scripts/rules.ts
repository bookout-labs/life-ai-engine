import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MAP, RULES, type Rule } from "../rules.ts";

const hooksSchema = z.object({
  hooks: z.record(
    z.string(),
    z.array(
      z.object({
        matcher: z.string().optional(),
        hooks: z.array(z.object({ type: z.string(), command: z.string() })),
      }),
    ),
  ),
});

export function render(map: string, rules: Rule[]): string {
  return `# Life AI\n\n${map.trim()}\n\n## Routed rules\n\n${rules.map(({ id, rule, trigger, route }) => `- **${id}**: ${rule} Trigger: ${trigger}. Route: ${route.kind} \`${route.file}\`${route.kind === "hook" ? ` (${route.event})` : ""}.`).join("\n")}\n`;
}

export function validate(repo: string, map: string, rules: Rule[]): string[] {
  const errors: string[] = [];
  if (map.trim().split(/\s+/).length > 250) errors.push("MAP exceeds 250 words.");
  const ids = new Set<string>();
  const pkg = z
    .object({ scripts: z.record(z.string(), z.string()) })
    .parse(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")));
  const workflowSchema = z.object({
    jobs: z.record(z.string(), z.object({ steps: z.array(z.object({ run: z.string().optional() })).optional() })),
  });
  const workflows = existsSync(join(repo, ".github/workflows"))
    ? readdirSync(join(repo, ".github/workflows"))
        .filter((file) => /\.ya?ml$/.test(file))
        .map((file) => {
          const workflow = workflowSchema.parse(parse(readFileSync(join(repo, ".github/workflows", file), "utf8")));
          return Object.values(workflow.jobs)
            .flatMap((job) => job.steps?.flatMap((step) => (step.run ? [step.run] : [])) ?? [])
            .join("\n");
        })
        .join("\n")
    : "";
  const invoked = new Set<string>();
  function expand(name: string): string {
    if (invoked.has(name)) return "";
    invoked.add(name);
    const command = pkg.scripts[name] ?? "";
    return [command, ...[...command.matchAll(/npm run ([\w:-]+)/g)].map((match) => expand(match[1] ?? ""))].join("\n");
  }
  const checks = [
    expand("check"),
    workflows,
    ...[...workflows.matchAll(/npm run ([\w:-]+)/g)].map((match) => expand(match[1] ?? "")),
  ].join("\n");
  function executes(command: string, file: string): boolean {
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `(?:^|[;&|\\n])\\s*node\\s+(?:--[\\w=-]+\\s+)*["']?(?:(?:\\$CLAUDE_PROJECT_DIR|/repo)/)?${escaped}["']?(?=\\s|$|[;&|])`,
      // Only the repo root, as each agent spells it, may prefix a route path.
    ).test(command.replaceAll("$(git rev-parse --show-toplevel)", "/repo"));
  }
  for (const rule of rules) {
    if (!rule.id.trim() || !rule.rule.trim() || !rule.trigger.trim())
      errors.push(`${rule.id}: id, rule and trigger must be nonempty.`);
    if (ids.has(rule.id)) errors.push(`Duplicate rule id: ${rule.id}`);
    ids.add(rule.id);
    if (rule.context && !existsSync(join(repo, rule.context)))
      errors.push(`${rule.id}: missing context ${rule.context}`);
    const file = join(repo, rule.route.file);
    if (!existsSync(file)) errors.push(`${rule.id}: missing route ${rule.route.file}`);
    // npm run check only runs .agents/**/*.test.ts, so a route outside .agents/ has tests nothing runs.
    const test = file.replace(/\.ts$/, ".test.ts");
    // A test counts only if it names the route it claims to cover (import or subprocess).
    const name = (rule.route.file.split("/").at(-1) ?? "").replace(/\.ts$/, "");
    if (!/^\.agents\/.+\.ts$/.test(rule.route.file) || !existsSync(test) || !readFileSync(test, "utf8").includes(name))
      errors.push(`${rule.id}: untested route ${rule.route.file} (needs a .test.ts beside it under .agents/)`);
    if (rule.route.kind === "hook") {
      const { event, tools } = rule.route;
      if (/ToolUse$/.test(event) && !tools.claude.length && !tools.codex.length)
        errors.push(`${rule.id}: ${event} route must list tools`);
      for (const [agent, config] of [
        ["claude", ".claude/settings.json"],
        ["codex", ".codex/hooks.json"],
      ] as const) {
        // A tool hook that lists no tools for an agent leaves that agent to enforce the rule natively.
        if (/ToolUse$/.test(event) && !tools[agent].length) continue;
        const groups = (
          hooksSchema.parse(JSON.parse(readFileSync(join(repo, config), "utf8"))).hooks[event] ?? []
        ).filter((group) =>
          group.hooks.some(
            (hook) =>
              hook.type === "command" && executes(hook.command.replaceAll('"', ""), file.slice(repo.length + 1)),
          ),
        );
        if (!groups.length) errors.push(`${rule.id}: ${event} not wired in ${config}`);
        for (const tool of tools[agent])
          if (!groups.some((group) => !group.matcher || new RegExp(`^(?:${group.matcher})$`).test(tool)))
            errors.push(`${rule.id}: ${config} matcher never fires on ${tool}`);
      }
    } else if (!executes(checks, rule.route.file)) errors.push(`${rule.id}: check not invoked: ${rule.route.file}`);
  }
  if (readFileSync(join(repo, "AGENTS.md"), "utf8") !== render(map, rules))
    errors.push("AGENTS.md drift. Run node .agents/scripts/rules.ts --write.");
  if (readFileSync(join(repo, "CLAUDE.md"), "utf8").trim() !== "@AGENTS.md")
    errors.push("CLAUDE.md must contain only @AGENTS.md.");
  return errors;
}

if (import.meta.main) {
  const repo = resolve(import.meta.dirname, "../..");
  if (process.argv.includes("--write")) writeFileSync(join(repo, "AGENTS.md"), render(MAP, RULES));
  const errors = validate(repo, MAP, RULES);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else
    console.log(
      `Rules OK: ${RULES.length} routed rules; MAP ${MAP.trim().split(/\s+/).length}/250 words; AGENTS.md current.`,
    );
}
