// Which paths may exist in the public engine repo, which need a board issue, proof and review. save.ts and gate.ts share it.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Kind = "code" | "system";

// Nothing personal is ever a kind: a path outside this list fails the gate.
const RULES: { kind: Kind; paths: string[]; proof: boolean }[] = [
  {
    kind: "code",
    paths: [
      "apps/",
      "packages/",
      "db/",
      ".agents/scripts/",
      ".agents/hooks/",
      ".github/",
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "neon.ts",
      "knip.json",
      "biome.json",
      "t3.json",
      ".mcp.json",
    ],
    proof: true,
  },
  {
    kind: "system",
    paths: [
      "docs/",
      ".claude/",
      ".codex/",
      ".agents/rules/",
      ".agents/rules.ts",
      ".agents/jobs/",
      ".agents/skills/",
      ".vale/",
      ".vale.ini",
      "AGENTS.md",
      "CLAUDE.md",
      "README.md",
      "LICENSE",
      ".gitignore",
    ],
    proof: false,
  },
];

export function kindOf(path: string): Kind | undefined {
  return RULES.find((rule) => rule.paths.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p)))?.kind;
}

// Every engine change names a board issue and gets the cross-family review; code also needs a production proof.
export function requirements(files: string[]): { proof: boolean } {
  return { proof: files.some((file) => kindOf(file) === "code") };
}

export function boardNumber(body: string): string | undefined {
  return /^Board: #([1-9]\d*)\r?$/m.exec(body)?.[1];
}

export function agentOf(body: string): string {
  return /^Agent: (\S+)\r?$/m.exec(body)?.[1] ?? "unknown";
}

export function missing(files: string[], body: string): string[] {
  const errors: string[] = [];
  const foreign = files.filter((file) => kindOf(file) === undefined);
  if (foreign.length) {
    errors.push(
      `Not engine paths: ${foreign.length} file(s). Records and prose go to Neon (pages.ts), files to R2 (files.ts); only code and system files live in git.`,
    );
  }
  if (!boardNumber(body)) {
    errors.push('Add "Board: #<n>" naming an open Builds issue: node .agents/scripts/save.ts … --issue <n>.');
  }
  const hasProof = body.split(/\r?\n/).some((line) => line.startsWith("Proof: ") && line.slice(7).trim().length >= 10);
  if (requirements(files).proof && !hasProof) {
    errors.push('Add "Proof: <10+ chars>" saying how it will be shown working in production: … --proof "<text>".');
  }
  return errors;
}

// Only what a diff adds; removing a personal line is the fix, not a leak.
export function added(diff: string): string {
  // A "+++" line is a file header only right after its "---" line; elsewhere it is an added line starting "++".
  const lines = diff.split("\n");
  return lines
    .filter((line, i) => line.startsWith("+") && !(line.startsWith("+++ ") && lines[i - 1]?.startsWith("--- ")))
    .map((line) => line.slice(1))
    .join("\n");
}

// Lines in any text that match the personal-term list (one regex per line, kept outside git). Counts only: never echo a match.
export function leaks(texts: string[], termList?: string): number {
  if (termList === undefined) {
    termList = process.env.PERSONAL_TERMS;
    if (termList === undefined) {
      try {
        termList = readFileSync(join(homedir(), ".config/life-ai/personal-terms"), "utf8");
      } catch {
        throw new Error("Personal-term list is missing. Configure PERSONAL_TERMS or the local personal-terms file.");
      }
    }
  }
  const terms = termList
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => t && !t.startsWith("#"));
  if (terms.length === 0) throw new Error("Personal-term list is empty.");
  let re: RegExp;
  try {
    re = new RegExp(terms.map((term) => `(?:${term})`).join("|"), "i");
  } catch {
    throw new Error("Personal-term list has an invalid pattern.");
  }
  return texts.flatMap((text) => text.split("\n")).filter((line) => re.test(line)).length;
}

export function requireOpenIssue(issue: string): void {
  let state: unknown;
  try {
    const repo = "bookout-labs/life-ai-engine";
    const out = execFileSync("gh", ["issue", "view", issue, "-R", repo, "--json", "state"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    state = JSON.parse(out).state;
  } catch {
    throw new Error(
      `Cannot read Builds issue #${issue}. It must exist and be OPEN; check the number and GitHub access.`,
    );
  }
  if (state !== "OPEN") throw new Error(`Builds issue #${issue} is ${state}. Choose an OPEN issue (… --issue <n>).`);
}
