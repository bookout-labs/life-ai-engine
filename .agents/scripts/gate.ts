// The required `gate` check. gate.yml runs main's copy of this file on pull_request_target, so a PR never judges itself.
// Fails on: a path outside the engine, a personal term, a missing or closed board issue, a missing proof,
// a blocked cross-family review, or a fourth blocked round without a Regroup comment.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { added, agentOf, boardNumber, leaks, missing, requireOpenIssue } from "./proof.ts";
import { blocking, MAX_ROUNDS, render, roundsSinceRegroup, review as runReview } from "./review.ts";

const env = (name: string): string => {
  const value = process.env[name];
  if (value === undefined) throw new Error(`gate: ${name} is not set`);
  return value;
};
const repo = env("GITHUB_REPOSITORY");
const pr = Number(env("PR"));
const head = env("HEAD_SHA");
const base = env("BASE_SHA");
const body = process.env.BODY ?? "";
const title = process.env.TITLE ?? "";

const sh = (cmd: string, args: string[]): string =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: "pipe", maxBuffer: 1 << 28 }).trim();
const gh = (...args: string[]): string => sh("gh", args);

try {
  // Both sides of a rename count, so moving a protected file to an unknown path still fails.
  const files = gh(
    "api",
    "--paginate",
    `repos/${repo}/pulls/${pr}/files`,
    "--jq",
    ".[] | .filename, (.previous_filename // empty)",
  )
    .split("\n")
    .filter(Boolean);

  // Added lines, commit messages, title and body; the list is an Actions secret and matches are counted, never printed.
  sh("git", ["fetch", "--no-tags", "origin", `pull/${pr}/head:refs/remotes/pr/${pr}`]);
  const diff = added(sh("git", ["diff", "--text", "-U0", `${base}...${head}`]));
  const log = sh("git", ["log", "--format=%B", `${base}..${head}`]);
  const hits = leaks([files.join("\n"), diff, log, title, body]);
  if (hits)
    throw new Error(`${hits} line(s) match the personal-term list. Personal data lives in Neon and R2, never in git.`);

  const errors = missing(files, body);
  if (errors.length) throw new Error(errors.join("\n"));

  const issue = boardNumber(body) ?? "";
  requireOpenIssue(issue);
  const card: {
    title: string;
    body: string;
    comments: { body: string; author: { login: string }; authorAssociation: string }[];
  } = JSON.parse(gh("issue", "view", issue, "-R", repo, "--json", "title,body,comments"));
  // A public repo: only the gate's own comments and Regroups from the save App or a maintainer move the count.
  // The org's membership is private, so the gate's token sees maintainers as outsiders; agents regroup as the App.
  const counted = card.comments.filter((c) =>
    c.body.startsWith("Regroup:")
      ? c.author.login.replace(/^app\//, "") === "bookout-life-ai-agents" ||
        ["OWNER", "MEMBER", "COLLABORATOR"].includes(c.authorAssociation)
      : c.author.login === "github-actions",
  );
  const rounds = roundsSinceRegroup(counted.map((c) => c.body));
  if (rounds >= MAX_ROUNDS) {
    throw new Error(
      `#${issue} has ${rounds} blocked review rounds. Stop patching: regroup with save.ts --issue <n> --regroup "<what failed, the new approach>", build that, then save again.`,
    );
  }

  const { reviewer, review } = runReview(agentOf(body), base, head, `${card.title}\n${card.body}`);
  const text = render(review);
  // The reviewer reads untrusted diffs; if one coaxed a reviewer login into the review, never publish it.
  const logins = [process.env.CLAUDE_CODE_OAUTH_TOKEN ?? ""];
  try {
    logins.push(...(readFileSync(join(homedir(), ".codex/auth.json"), "utf8").match(/[\w.-]{20,}/g) ?? []));
  } catch {
    // No Codex login on this runner.
  }
  const exposed = logins.some((login) => login.length >= 20 && text.includes(login));
  const safeText = leaks([text]) || exposed ? "Review details withheld by personal or credential scan." : text;
  const blockers = blocking(review);
  if (blockers.length) {
    const list = blockers.map((f) => `- [P${f.priority}] Finding withheld`).join("\n");
    gh(
      "issue",
      "comment",
      issue,
      "-R",
      repo,
      "-b",
      `Review blocked (round ${rounds + 1}/${MAX_ROUNDS}, ${reviewer}) at ${head}\n\n${list}`,
    );
    throw new Error(`Review blocked (${reviewer}): fix the P0/P1 findings, then save again.`);
  }
  gh(
    "pr",
    "comment",
    String(pr),
    "-R",
    repo,
    "-b",
    `Review: pass (${reviewer}, ${review.findings.length} notes) at ${head}\n\n${safeText}`,
  );
  console.log("Gate passed.");
} catch (err: unknown) {
  console.error(
    err instanceof Error && !(err instanceof SyntaxError) && !("stderr" in err)
      ? err.message
      : "Gate command failed; details withheld.",
  );
  process.exitCode = 1;
}
