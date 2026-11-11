import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { z } from "zod";

const issuesSchema = z.array(
  z.object({
    number: z.number(),
    title: z.string(),
    state: z.string(),
    body: z.string(),
  }),
);
type Issue = z.infer<typeof issuesSchema>[number];

type HookConfig = { hooks: Record<string, { hooks: { command: string }[] }[]> };

export function weedIssue(path: string, issues: Issue[]): string {
  const dir = path.slice(0, path.lastIndexOf("/"));
  const word = (text: string, ext = "") =>
    new RegExp(`(^|[^\\w.-])${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${ext}($|[^\\w.-])`);
  const name = word((path.split("/").pop() ?? path).replace(/\.\w+$/, ""), "(\\.\\w+)?");
  const folder = word(dir.split("/").pop() ?? dir);
  const matches = issues.filter((issue) => {
    if (!issue.title.startsWith("Weed ")) return false;
    if (issue.title.includes(path)) return true;
    const inFolder = issue.title.includes(dir) || folder.test(issue.title);
    if (inFolder && name.test(issue.title)) return true;
    return issue.body.split("\n").some((line) => {
      const cells = line.split("|");
      if (cells.length < 3 || (cells[0] ?? "").trim()) return false;
      const first = (cells[1] ?? "").trim();
      const cell = (/^\d+[.)]?$/.test(first) ? (cells[2] ?? "").trim() : first).replace(/^[`[]+/, "");
      return cell.startsWith(path) || (inFolder && name.test(cell.split(/\s/)[0] ?? ""));
    });
  });
  return matches.length ? `#${Math.max(...matches.map((issue) => issue.number))}` : "not weeded";
}

export function table(files: string[], hooks: string[], issues: Issue[], read: (path: string) => string): string {
  const tracked = new Set(files);
  const lines = (path: string) => (read(path).match(/\n/g) ?? []).length;
  const code = files.filter(
    (path) =>
      /^(\.agents|packages|apps)\//.test(path) && /\.(ts|tsx|js|jsx|html|css)$/.test(path) && !/\.test\.ts$/.test(path),
  );
  const workflows = files.filter((path) => path.startsWith(".github/workflows/"));
  const skills = files.filter((path) => /^\.agents\/skills\/[^/]+\/SKILL\.md$/.test(path));
  const rows = [...code, ...workflows, ...skills].map((path) => {
    const test = path.replace(/\.ts$/, ".test.ts");
    const testLines = test !== path && tracked.has(test) ? String(lines(test)) : "";
    const issuePath = path.endsWith("/SKILL.md") ? path.slice(0, -9) : path;
    return `| ${path} | ${lines(path)} | ${testLines} | ${weedIssue(issuePath, issues)} |`;
  });
  for (const hook of hooks) {
    const path = hook.match(/\.agents\/hooks\/[\w.-]+\.ts/)?.[0] ?? hook;
    rows.push(
      `| ${hook.replaceAll("|", "\\|")} | ${tracked.has(path) ? lines(path) : ""} | ${tracked.has(path.replace(/\.ts$/, ".test.ts")) ? lines(path.replace(/\.ts$/, ".test.ts")) : ""} | ${weedIssue(path, issues)} |`,
    );
  }
  return ["| Path | Lines | Test lines | Weed issue |", "| --- | ---: | ---: | --- |", ...rows].join("\n");
}

if (import.meta.main) {
  const files = execFileSync("git", ["ls-files", ".agents", "packages", "apps", ".github/workflows"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  const hooks = [".claude/settings.json", ".codex/hooks.json"].flatMap((path) => {
    const config: HookConfig = JSON.parse(readFileSync(path, "utf8"));
    return Object.values(config.hooks).flatMap((entries) =>
      entries.flatMap((entry) => entry.hooks.map((hook) => hook.command)),
    );
  });
  const issues = issuesSchema.parse(
    JSON.parse(
      execFileSync(
        "gh",
        [
          "issue",
          "list",
          "--state",
          "all",
          "--search",
          "Weed in:title",
          "--json",
          "number,title,state,body",
          "--limit",
          "500",
        ],
        { encoding: "utf8" },
      ),
    ),
  );
  console.log(table(files, hooks, issues, (path) => readFileSync(path, "utf8")));
}
