# Enforcement

Save from an isolated worktree branch with `node .agents/scripts/save.ts --work LAB.1.3 -m "Change summary" --issue <number> --proof "Production observation" <paths>`. Code requires production proof. Every engine change requires an open board issue. `--no-wait` returns after auto-merge is armed; the caller then links and watches the PR in T3.

The local save stages explicit paths, checks the allowlist and personal terms, runs npm run check, commits trailers and pushes. It creates or updates the branch PR through App installation 180008533. Failures leave the branch and PR available for retry.

Run `node .agents/scripts/worktree-sweep.ts` to list merged, clean T3 worktrees idle for 48 hours, ignoring regenerable output but protecting ignored secret files; `--remove` opts into removal after process-safety checks.

## CI walls

The required gate and secrets checks run on pull_request_target from main. They read PR data without installing or executing PR code. Forks receive no passing gate. The gate scans added lines, commit messages, title and body before review. Unknown paths fail. Personal terms are regular expressions supplied through PERSONAL_TERMS or ~/.config/life-ai/personal-terms. Missing, empty or invalid configuration refuses. Output contains counts only.

Claude-built changes wait for Codex Cloud review at the exact head SHA. Codex-built changes use Claude CLI structured output. P0/P1 findings block. Three blocked rounds require a Regroup comment on the board issue, which the building agent posts as the save App with save.ts --regroup. The merge queue reruns check on the combined tree. The gate and secrets queue jobs acknowledge the prior PR judgment.

Ship migrates before deploying, runs production smoke checks and posts only identifiers and a run link on the board issue. The agent closes the issue once its acceptance evidence holds. Nightly drift checks production versions, schema, the tree and recent history. Hooks are local tripwires; GitHub settings enforce merge policy.

## Accepted limits

Agent trailers are self-reported. Reviewer judgment can miss weakened tests. When the other family's reviewer can't run, the builder's own family reviews as a last resort so the gate never stalls; the pass comment names the reviewer (Joe, #131). Reviewers read untrusted text. Local scans remain necessary because public branches and automatic review can expose data before the gate runs. The personal-term list is maintained privately and cannot detect terms it does not contain.
