---
name: weed
description: Weed one script, hook or workflow down to what Life AI must own. Use when Joe names a script to weed, trim, audit or reduce, asks which parts a platform already does better, or asks what is left to weed.
---

Weeding takes one script per run, in stages, and each stage ends at Joe. Joe decides; the run builds nothing until he has chosen. The final form is the frame: one public engine repo, every thread in its own T3 worktree, personal data in Neon and R2.

The ledger is the Builds board: one issue per script, titled `Weed <path>`. It holds the snapshot verdicts, Joe's decisions and the result. Read every closed `Weed` issue before starting a run, so a job already moved to a platform in an earlier run is recognized here as duplicate.

## 0. Queue, when Joe asks what is left

List every script under `.agents/`, every hook wired in `.claude/settings.json` and `.codex/hooks.json`, and every workflow, with line counts, test line counts and `Weed` status. Show it as a table.

Done when every file is in the table.

## 1. Whole script

Finish the previous run's step 8 first, then start from current main, so the run judges the script as it is now. Find every caller: hooks config, workflows, package.json scripts, the rules registry, other scripts and skills. Measure how often it runs and how long one run takes. For hooks, the cost per call matters most, because it is paid on every matching tool call. Ask whether the whole script can go. Open its `Weed` issue.

Done when the issue records the callers, frequency, run time and a whole-script verdict.

## 2. Inventory

Read the script end to end, plus everything it imports and its tests. Split it into pieces: contiguous line ranges that each do one job. For each piece, name the real failure it prevents, citing the PR, issue or incident from git log and the board. A piece with no failure behind it is speculative machinery. A piece that never runs may be switched off rather than unwanted: check Joe's environment, user config and sibling repos before calling it dead.

Done when every line belongs to exactly one piece, and each piece has a line range, one plain sentence, and a cited failure or "none found".

## 3. Platform check

For each piece, find whether one of these already does the job:
- T3 Code;
- GitHub (Actions, rulesets, auto-merge, merge queue, Projects);
- each agent's own harness or CLI (Claude, Codex, Grok): when a piece calls a model or an agent, check whether every provider can do it the same way, so one path serves them all;
- Cloudflare;
- Neon;
- git itself;
- a maintained open-source package;
- existing code elsewhere in this repo. A sibling repo shows what Joe wants, not how to build it; its code has not been weeded, so don't copy it.

Use current primary docs and the `lab` skill's research order. Cite each source and mark every claim confirmed or unverified.

Done when every piece has a verdict of Keep, Platform (naming the feature), Reuse (naming the file), Delete, or Joe's call, and every Platform or Reuse verdict has its citation.

## 4. Counter-case

For every piece marked Platform, Reuse or Delete, argue for keeping it. Ask whether the local version:
- saves tokens (a blocking wait costs none; a wake-up costs a turn);
- saves wall-clock time (it fails before a push or CI round trip);
- adds safety;
- gives control (structured output, deterministic blocking).

Flip the verdict when the local version wins, and say what it wins on.

Done when each Platform, Reuse or Delete verdict carries a one-line answer to "what would we lose?"

## 5. Snapshot

Copy `snapshot-example.html` from this folder into the scratchpad and replace its content, keeping the layout:
- the line-split bar;
- one card per piece;
- the "where it would land" table;
- the "not available" notes.

Add the whole-script verdict and the run-time figures above the cards. Show it with `html_render`, post the verdict table on the `Weed` issue, and reply with only what the page doesn't say.

Done when Joe has seen the page. Stop there and wait for his questions or decision.

## 6. Redesign, when Joe asks

Brief an independent agent from the other model family, or Fable when Joe names it. Hand it:
- the script;
- the snapshot;
- the `Weed` issue;
- the final-form frame.

Have it verify the snapshot's claims against primary sources and judge every piece again. It writes the redesign and draft files to the scratchpad, never the repo. Relay where it disagrees.

Done when Joe has the redesign, its open questions, and the line counts before and after.

## 7. Build

A weed makes the script smaller as well as better, more reliable, free of bugs and more efficient; a fix that adds machinery is not a weed. Before building, merge main again and drop anything main already fixed, then write the script's scope into its rule text, or into the `Weed` issue when it has no rule: what it must stop, and what is out of scope. Judge every review finding against that scope; a finding outside it is not a blocker, so bring it to Joe instead of adding code. Set the `Weed` issue's "Done means" to all of these:
- better: it does its job for every agent and model Joe keeps in scope, so any one provider can be out of usage; a provider whose tool still fails after two tries goes to Joe instead of more debugging;
- more reliable: it can't fail open on a missing dependency, untrusted config or crash, and each agent is shown to actually run it;
- free of bugs: tests pass, apart from tests of deleted machinery; a live run per agent proves each blocked and allowed case; the cross-family review is clean;
- more efficient: lines, run time and call count are all lower, with before and after numbers posted;
- the change is proven in production.

Build through the normal save flow, and record Joe's decisions on the issue.

## 8. Sharpen this skill

List this run's hiccups. A hiccup is any of these:
- Joe corrected a verdict or a claim;
- a verdict flipped after the snapshot;
- a stage was redone;
- a stage's "Done when" was met while the work was still incomplete;
- an instruction here sent the run the wrong way.

A wording preference without a cost in this run is not a hiccup. For each hiccup, change the step or "Done when" that would have prevented it. Prefer sharpening or replacing a line over adding one, so the skill stays the same length unless a hiccup needs a new rule. Post the hiccups and the edit on the `Weed` issue, and save the skill change with it.

Done when every hiccup has either an edit that prevents it or a one-line reason it needs none. A run with no hiccups leaves this file unchanged.
