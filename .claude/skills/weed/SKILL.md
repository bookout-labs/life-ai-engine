---
name: weed
description: Weed one script or hook down to what Life AI must own. Use when Joe names a script to weed, trim, audit or reduce, or asks which parts a platform already does better.
---

Weeding takes one script per run, in stages, and each stage ends at Joe. Joe decides; the run builds nothing until he has chosen. The final form is the frame: one public engine repo, every thread in its own T3 worktree, personal data in Neon and R2.

## 1. Inventory

Read the script end to end, plus everything it imports and calls. Split it into pieces: contiguous line ranges that each do one job.

Done when every line belongs to exactly one piece, and each piece has a line range and one plain sentence saying what it does.

## 2. Platform check

For each piece, find whether T3 Code, GitHub (Actions, rulesets, auto-merge, Projects), the Claude Code or Codex harness, Cloudflare, Neon, git itself or a maintained open-source tool already does that job. Use current primary docs and the `lab` skill's research order. Cite each source and mark every claim confirmed or unverified.

Done when every piece has a verdict of Keep, Platform (naming the feature), Delete, or Joe's call, and every Platform verdict has a cited source.

## 3. Counter-case

For every piece marked Platform or Delete, argue for keeping it. Does the local version save tokens (a blocking wait costs none; a wake-up costs a turn), wall-clock time (fails before a push or CI round trip), safety, or control (structured output, deterministic blocking)? Flip a verdict when the local version wins, and say what it wins on.

Done when each Platform or Delete verdict carries a one-line answer to "what would we lose?"

## 4. Snapshot

Write a page into the scratchpad: title, line count, and a bar splitting lines into Platform, Keep and Joe's call. Add one card per piece (number, name, lines, what it does, a verdict tag, one-sentence reason), a "where it would land" table, and anything unavailable with the reason. Show it with `html_render`, using T3 theme variables. Reply with only what the page doesn't say.

Done when Joe has seen the page. Stop there and wait for his questions or decision.

## 5. Redesign, when Joe asks

Brief an independent agent from the other model family, or Fable when Joe names it. Hand it the script, the snapshot and the final-form frame. Have it verify the snapshot's claims against primary sources and judge every piece again. It writes the redesign and draft files to the scratchpad, never the repo. Relay where it disagrees.

Done when Joe has the redesign, its open questions, and the line counts before and after.

## 6. Build

Open a board issue whose "Done means" names the production proof, then build through the normal save flow.
