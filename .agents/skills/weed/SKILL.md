---
name: weed
description: Weed one script, hook, skill or workflow, or a whole process, down to what Life AI must own. Use when Joe names a script, skill or process to weed, trim, audit or reduce, asks which parts a platform already does better, or asks what is left to weed.
---

A weed run takes one target and goes through the steps in order. Research builds nothing. After step 5 the run stops for Joe's decision, unless Joe recorded a standing authorization (on an issue, a page or in a thread) whose scope names this target or its group. Then the coordinator links that record, writes "Decided under Joe's standing authorization <link>; Joe may reverse" on the issue, and goes on to step 7. A process run always stops after step 5.

The ledger is the Builds board: one issue per target, titled `Weed <path>`. Before step 1, search open and closed `Weed` issues for the target's path and for each job it does (`gh issue list --state all --search "Weed in:title <word>"`), and read each one found. A job an earlier run moved to a platform is a duplicate here.

## 0. Queue, when Joe asks what is left

List every code file under `.agents/`, `packages/` and `apps/`, every hook in `.claude/settings.json` and `.codex/hooks.json`, every GitHub workflow and every skill, in one table. Answer from this table, never from the open issues.

Done when every file, hook, workflow and skill has a row showing its lines, test lines, and `Weed` issue number or "not weeded".

## Process runs

When Joe names a process, such as build → save → gate → merge → ship, the target is the chain. Step 1 traces one real run from transcripts, PRs and Actions logs: every script, hook, agent turn, model call and wait, with its wall-clock time. The pieces are the hops. A process run only finds; each script it changes is built later as its own weed.

Done when the issue has a table of one real run's hops, each with its time and a verdict.

## 1. Whole target

Finish the previous run's step 8, then start from current main. Find every caller in hooks config, workflows, package.json, the rules registry, scripts and skills, searching the whole repo including `apps/`. Find the commit, issue and Joe's decisions that created the target, including in its original repo. Measure how often it runs and how long one run takes; for a hook, the cost of one call; for a skill, its words and the turns it causes. Write "not measured" with the reason when you can't. Open its `Weed` issue.

Done when the issue body has five filled fields: origin (commit and issue), callers (with file paths), how often it runs, how long one run takes, and a one-sentence verdict on deleting the whole target.

## 2. Inventory

Read the target, its imports and its tests. Split it into pieces: in code, a run of lines doing one job; in a skill or process, one step, rule or hop. For each piece, cite the PR, issue or commit showing the failure it prevents, or write "none found". A piece an agent does the same way every time can become a script, which costs no tokens. Before calling a piece dead, search the whole repo including `apps/`, Joe's `~/.claude` and `~/.codex`, and his sibling repos.

Done when the issue has a table in which every line of the target sits in exactly one row, each with a line range, one sentence on what it does, and a cited failure or "none found".

## 3. Platform check

For each piece, check whether one of these does its job: T3 Code; GitHub Actions, rulesets, merge queue or Projects; the Claude, Codex or Grok CLI (when a piece calls a model, check every provider can do it the same way); Cloudflare, Neon or git; a maintained npm package through its own entry point; or other code in this repo, counting every copy, not only those in the target. Never copy a sibling repo's code.

Cite official docs, release notes or source code for each finding, marked confirmed or unverified. A claim about what an agent does, such as picking a skill or getting stuck, is confirmed only by a live run per agent with the target off, or by a transcript, issue or reflog.

Done when every row has one verdict: Keep; Platform with the feature's doc link; Reuse with the file path; Script with the script path; Delete; or Joe's call with the question.

## 4. Counter-case

For each Platform, Reuse, Script or Delete row, argue for keeping the local version. It wins if it:

- saves turns (a blocking wait costs none; each wake-up costs one);
- fails before a push or CI run;
- keeps a write path's error order, ID allocation and rollback, which a few saved lines never justify changing;
- gives structured output or a deterministic block.

For Script, ask whether the step needs judgment. When a verdict reverses a decision of Joe's, quote it and say what changed. When the local version wins, change the verdict to Keep and say why.

Done when every Platform, Reuse, Script and Delete row has a "What would we lose?" cell naming each affected agent, or "nothing".

## 5. Snapshot

Copy `snapshot-example.html` to the scratchpad and replace its content, keeping its line-split bar, one card per piece, "where it would land" table and "not available" notes. Put the whole-target verdict and run times above the cards. Show it with `html_render`, post the verdict table on the issue, and reply with only what the page doesn't say plus each Joe's-call question with your recommendation.

Done when `html_render` has shown the page and the verdict table is on the issue. Then wait for Joe's decision, or decide under his standing authorization.

## 6. Redesign, only when Joe asks or a verdict is contested

A verdict is contested when Joe questions it or the coordinator disagrees with the researcher. Give an agent from the other model family, or Fable when Joe names it, the target, snapshot and issue. It rechecks the claims against primary sources, judges every piece again, and writes drafts to the scratchpad, never the repo.

Done when Joe has the redesign, the pieces it disagrees on, and line and word counts before and after.

## 7. Build

A weed makes the target smaller and changes nothing outside its scope; adding machinery is not a weed. Merge main and drop what main already fixed. Write the scope in the issue body: what the target must stop or do, and what is out of scope. The gate reads only the body, so update it when Joe changes the scope. A review finding outside the scope goes to Joe, not into code.

Write "Done means" in the issue body:

- Claude and Codex each run it; a provider that fails twice goes to Joe;
- it can't fail open on a missing dependency, bad config or crash;
- tests pass, except tests of deleted code;
- a live run per agent before and after shows each allowed and blocked case, and that what the agent sees, what blocks it, and when merges and waits happen are unchanged outside the scope (lab has the Neon and Codex commands);
- the cross-family gate review passes;
- lines go down; post lines, run time and call count before and after, even when unchanged;
- ship.yml's evidence comment is on the issue, plus any production check the scope names.

Build through save.ts and record Joe's decisions on the issue.

Done when each "Done means" item has its evidence on the issue and the issue is closed.

## 8. Sharpen this skill

A hiccup is any of these:

- Joe corrected a verdict or claim;
- a verdict changed after the snapshot;
- a step was redone;
- a step's "Done when" was met while its work was incomplete;
- a line here sent the run the wrong way.

A wording preference that cost nothing is not a hiccup. For each hiccup, change the step or "Done when" that would have prevented it, preferring a replaced line or a code check over a new line. Run `wc -w` on this file before and after; the count may grow only for a new rule a hiccup needs, named on the issue. Post the hiccups, edit and word counts on the `Weed` issue and save the edit with it. A chain may post its hiccups once at the end.

Done when every hiccup has an edit or a one-line reason it needs none, and both word counts are on the issue. A run with no hiccups leaves this file unchanged.
