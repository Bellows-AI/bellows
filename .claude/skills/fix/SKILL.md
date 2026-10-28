---
name: fix
description: Fix a GitHub issue end-to-end in an isolated git worktree — fetch with gh, plan with the fix-planner subagent, TDD implementation, review loop with the reviewer subagent, commit, push, open PR, then wait for GitHub review and address every comment in a bounded loop. Trigger phrases: "/fix", "fix this issue", "fix the GitHub issue", "work on issue #N".
---

# Fix a GitHub issue end-to-end

Fix the issue given as the argument. Run all seven phases in order, autonomously — do not
pause for approval between phases; stop only when genuinely blocked (see the stop conditions in
each phase). Track progress with the todo tool throughout.

Everything from Phase 1 on — planning included — runs inside a dedicated git worktree, never the
main checkout.

## Issue source and reviewer

Two blocks plug into the phases below; a skill that wraps this one names its own.

- **Issue source** — default `<root>/.claude/skills/fix/blocks/source-github.md`. It defines the
  argument it takes, REF (how prose, briefs and the PR name the issue), `<N>` (the tag every name
  below carries: worktree, branch, `fix<N>` resources, CLEANUP), and the steps this skill calls by
  name: **Fetch**, **Close line**, **File a follow-up**, **After the PR**.
- **Reviewer** — default: the `reviewer` subagent of Phase 4. A review block
  (`<root>/.claude/skills/fix/blocks/review-codex.md`) adds to and replaces phases as it states.

## Heavy commands and cleanup

Several fix runs share one host, and unqueued suites saturate it until tests time out. Two scripts
beside this file prevent that; call them by absolute path from the main checkout — HEAVY is
`<root>/.claude/skills/fix/heavy.sh`, CLEANUP is `<root>/.claude/skills/fix/cleanup.sh`. These rules
cover every command this skill names below.

- Heavy commands run as `sh HEAVY <command>`: `npm test`, `npm run typecheck`, `npm run build`, a
  directory-wide `npx vitest run <dir>`, `npx vitest run --changed`, `npm run test:changed`, `docker build`, `make runners`
  and `codex exec`. A
  single-file `npx vitest run <path>` and `npm run lint:changed` run bare.
- Lanes with fixed ports or project names run as `sh HEAVY --exclusive <command>`:
  `npm run test:jobs`, `npm run test:k8s`, `npm run verify:ui`.
- `test:jobs` lanes: iterate and check a PR with `npm run test:jobs -- --changed origin/main` (or
  `--phase a,b` for a hand-picked pair); it prints the phases it chose and why, and runs the full lane
  itself when a shared file changed. The full default `npm run test:jobs` runs once at the end of a PR
  series and on `main`, not per PR.
- **A failed lane is not rerun to find its cause.** After `test:jobs`, `test:k8s` or `verify:ui`
  fails, that lane runs again only once the plan file records one of two things. Either a test
  outside the lane that reproduces the failure — red before the fix, green after (Phase 3, RED) —
  or an environmental verdict quoting its evidence (exit 137/143, `fork: Resource temporarily
  unavailable`, an out-of-memory kill, host load far above the core count), which allows one rerun.
  The same case failing twice is never environmental: reproduce it.
- HEAVY waits for a free slot (2 per host, `FACTORY_HEAVY_SLOTS`) and prints who holds them. The wait
  is the point: never bypass it, never kill a holder. Launch long ones with `run_in_background`.
- Name everything the run creates outside the worktree `fix<N>` or `fix<N>-<what>` — kind clusters
  (`make cluster CLUSTER=fix<N>`), compose projects, containers (`fix<N>-pg`), volumes, networks.
  CLEANUP finds them by that name and nothing else.
- `sh CLEANUP <N>` removes them, kills processes still running from the issue's worktrees and
  orphaned test progress filters, and leaves worktrees and branches alone. Run it at every exit of
  this skill — done, or any STOP — and before Phase 1 when an earlier run of the issue may have left
  something behind.

## Context budget

Every turn re-reads the whole context, so context size × turns is what a run costs: one agent at
600K tokens for 250 turns outspends the rest of the run. These rules bind this conversation and
every agent it spawns — copy them into each brief.

- **Read narrowly.** Locate with `git grep -n` first, then read only the range you need — at most
  ~150 lines (`sed -n <a>,<b>p`, or Read with offset/limit). Never `cat` a whole source file or doc
  to look for something, and never re-read a range already in context unless it changed since.
- **Suite output stays on disk.** Run every suite to a log (`> <scratchpad>/<what>.log 2>&1`) and
  read only the verdict and the failures (`tail -n 30`, `grep -n -E 'FAIL|Error'`). A green run
  needs nothing beyond its exit code.
- **Wait in one call.** This conversation launches a long command with `run_in_background` and
  ends its turn; the exit notification wakes it. An agent cannot end its turn to wait, so it waits
  in one foreground call that ends when the job does — `until <done-check>; do sleep 15; done` with
  the Bash timeout at 600000, repeated only on timeout. Never a loop of sleeps, a `Monitor` around a
  `sleep`, an `echo` to pass a turn, or repeated status checks.
- **One implementer per commit, in sequence.** Implementation stays in this conversation by
  default. When the plan spans several commits and you delegate them, spawn one agent per commit:
  one Agent call per message, never a second launch while one runs, never two agents on the same
  commit or tree. The brief points at files (the plan, the issue JSON) instead of pasting them; the
  agent returns under 200 words plus the commit sha.
- **Implementers are fresh agents, never forks.** A fork starts with this whole conversation.
  Each review round's fixes go to a new agent briefed with the round's findings file — never
  `SendMessage` into an agent that already ran a round.
- **Watch every background agent.** When the first one launches, start WATCHDOG
  (`<root>/.claude/skills/fix/watchdog.sh`) with `run_in_background`:
  `sh WATCHDOG <worktree>[:<log>...] ...`, one argument per agent — its worktree, then the logs it
  writes. It spends no turns while the agents progress, and exits — the one notification — when an
  agent shows no change for 45 minutes or no commit for 90 (exit 3, one `stale:` line each), when
  every watched path is gone, or after 110 healthy minutes (exit 0: start it again for the agents
  still running). Restart it when the set of agents changes. Never a scheduled model tick to check
  on agents. A stale agent: stop it, have it or you write `<scratchpad>/handoff-<N>.md`, and resume
  with a fresh agent or in this conversation.

## Phase 0 — Fetch the issue

- If no issue was given, ask for one and stop.
- Run the issue source's **Fetch**: the issue with full detail, comments included, saved to
  `<scratchpad>/issue-<N>.json`. A failed or unreadable fetch is a STOP, never an empty issue.
- If the issue is already closed, say so and ask whether to proceed.
- Before touching any code, read this repo's AGENTS.md and the `docs/` file that covers the area
  you will change — the "Read before you touch" table maps areas to files.

## Phase 1 — Create the worktree

**Factory task exception:** if the current branch already matches `factory/<uuid>`
(`git branch --show-current`), this run is a Factory board task — the worktree and the branch
already exist and the board resumes follow-ups on that exact checkout. Skip the creation steps
below: WORKTREE is the current directory, and wherever this phase says `fix/<N>-<slug>`,
read the task branch you are on. Never create or switch branches in this tree — leaving it off the
task branch strands the run: the board's resume gate refuses a follow-up whose checkout is not on
`factory/<uuid>`, and the work becomes unreachable to the thread that owns it.

1. Resolve the repo root (`git rev-parse --show-toplevel`) and the default branch
   (`gh repo view --json defaultBranchRef -q .defaultBranchRef.name`), then update the base:
   `git fetch origin <default-branch>`.
2. Create the worktree as a sibling of the repo root, with a fresh branch off the default branch:
   `git worktree add <root>/../<repo-name>-fix-<N> -b fix/<N>-<short-slug> origin/<default-branch>`
   The slug comes from the issue title. Never reuse an existing branch or an existing path; if
   creation fails, stop and ask.
3. Untracked files do not follow a worktree, so recreate the environment: clone dependencies from
   the main checkout when possible (`cp -cR <root>/node_modules <worktree>/node_modules` — APFS
   copy-on-write, near-instant), falling back to `npm install`. Copy any gitignored local files
   the toolchain needs too (`.env` and the like).
4. Prove the worktree can actually run tests before moving on: `npm run build -w core`, then one
   file, `npx vitest run core/test/core-index.test.ts`. The full suite waits for the Phase 5 gate.
5. Record the worktree path as WORKTREE. From now on every command runs with WORKTREE as its
   working directory — absolute path, never a relative `cd`.

## Phase 2 — Plan (fix-planner subagent)

- Gather context: AGENTS.md and the docs file covering the area the issue concerns, read from
  WORKTREE.
- Spawn the `fix-planner` subagent (task tool) with the issue JSON and that context, and tell it
  the repository root is WORKTREE. Trust its analysis and work with its output; do not re-plan
  unless it is demonstrably wrong, in which case say why.
- Turn its plan into your todo list, one todo per approach step, each with the test or command
  that verifies it.
- If the plan marks anything `BLOCKER` in Risks / ambiguity, STOP: present the ambiguity and the
  planner's analysis to the user. Do not pick an interpretation yourself.
- **Design forks go in one batch.** Before the plan becomes final, collect every design fork (the
  planner's `Design forks` plus your own) and ask them in ONE `AskUserQuestion` call — up to 4
  questions, the recommended option first in each. More than 4: ask the 4 that most change the plan
  and take the recommended default for the rest. After that batch a fork found later (planning,
  review, lanes, GitHub review) never stops the run: take the recommended default, record it in
  the plan and in the PR body under a "Decided on default" list, and continue — unless the choice
  is irreversible or outward-facing (data loss, publishing, deleting shared resources), which
  still asks. An ambiguity in the issue itself stays a `BLOCKER`.
- **Hazard check before the first review round.** Check the plan's Hazards section against the
  fix-planner's list (every hazard line in its output format) and amend gaps yourself, so review
  rounds spend themselves on new problems, not on classes the list already names. Do the same on
  the diff before the first Phase 4 round.

## Phase 3 — Implement, TDD

The suite commands here are the focused suite (below) and `npm run typecheck`. Single file:
`npx vitest run <path>`. The full `npm test` runs once, as the Phase 5 gate — never per iteration.

**Focused suite** — every test the change can reach, run from WORKTREE with
BASE=`git merge-base HEAD origin/<default-branch>`:

`sh HEAVY npm run test:changed -- $BASE` runs all three of the following in one go: it builds core
when `core/src` changed, and maps a changed non-TypeScript file to the suites that name it. Spawn-tier
suites (`vitest.spawn-tests.json`) run only when a file they import or name changed. To iterate on
one package, `npx vitest run --project <pkg>`.

- `sh HEAVY npx vitest run --changed $BASE` — each test file whose import graph reaches a file
  changed since BASE, uncommitted work included.
- The diff touches `core/src`: `npm run build -w core`, then also
  `sh HEAVY npx vitest run server/test web/test` — they import `@factory-ai/core` from
  `core/dist`, which the graph does not follow back to `core/src`.
- The diff touches a file tests read by path rather than import (docs, `.sh`, `.sql`,
  `driver/src/scripts/*`, `charts/`, skills): also each test that names it,
  `git grep -l <basename> -- '*/test/*' e2e`.

Style is enforced by biome — run `npm run lint:changed` before
committing (only the files the branch touched, at low CPU priority; never the whole-repo
`npm run lint`, which CI runs), and `npm run lint:changed -- --write` (or `npm run format` for pure
format drift) to settle what it flags.

In order:

1. RED: write a test that reproduces the issue. Run it (in WORKTREE) and confirm it FAILS for the
   expected reason — a setup error is not a red. Prefer an integration test — the real modules
   together, only the outermost boundary faked, timers compressed — over a slow real lane: it
   runs in seconds, so it is where the fix is prototyped and debugged. A failure a lane
   (`test:jobs`, `test:k8s`) reports is reproduced this way before the lane runs again; the lane
   only confirms the fix.
2. GREEN: write the minimum implementation that makes it pass. No features beyond the issue, no
   speculative abstractions.
3. Run the focused suite plus `npm run typecheck`. If existing tests break, fix them before
   proceeding — never delete or skip a test to get green.
4. Tests must be isolated from each other and never hardcode database ids or environment-specific
   values.

Build coupling to remember: `server` and `web` resolve `@factory-ai/core` to `core/dist` — if
type errors point into core, run `npm run build -w core` before hunting source bugs.

## Phase 4 — Review loop (max 3 rounds)

For each round, up to 3:

1. Produce the complete diff: `git diff $(git merge-base HEAD <default-branch>)...HEAD` (plus
   uncommitted changes staged first into a temp view if needed — the reviewer must see everything
   you changed).
2. Write the diff to `<scratchpad>/diff-<N>-r<round>.patch` — never into this conversation — and
   spawn the `reviewer` subagent (task tool) with: that path, the issue title and body, and a
   one-paragraph summary of the approach.
3. Triage its findings:
   - Blockers (bugs, broken error handling, missing coverage for the change, security issues):
     fix, re-run the focused suite, continue to the next round.
   - **Fix the class, not the line.** Name each accepted blocker's class (an unconfirmed read
     taken as empty, a signal that never reaches a delete, a missing counterpart, …) and fix every
     instance of it in the code the change adds or calls — search for them; the line the reviewer
     named is one instance. A later round that finds the same class again means this fix was
     incomplete.
   - A defect in pre-existing code the change does not call is not this PR's blocker: file it as
     an issue with the issue source's **File a follow-up** and record it as `deferred: <ref>`.
   - Nitpicks/style: fix only if trivial; do not loop on them.
4. A round with zero blockers ends the loop.

After 3 rounds with blockers remaining: STOP. Commit nothing, push nothing. Report the remaining
findings to the user with your analysis. The cap is the user's to raise, never the run's.

## Phase 5 — Ship

Pre-flight (all inside WORKTREE):

- `git status` must show only the files your change touched. Anything else was made during this
  run — revert it; never mix it into the PR.
- `git log --oneline -10` — match the repo's existing commit message style.
- Stage only the files your change touched. Never commit secrets, keys, or .env files.
- The gate: the full `sh HEAVY npm test`, `npm run typecheck` and `npm run lint:changed`, once,
  here. A failure is fixed and the gate re-run before anything is committed.

Then:

1. You are already on the branch chosen in Phase 1 — `fix/<N>-<short-slug>`, or the
   Factory task branch (`factory/<uuid>`) when this run is a board task; do not cut another.
2. Commit with a message referencing the issue by REF.
3. Bring the branch up to date with the default branch before pushing. Up to 2 attempts; each
   attempt is fetch, merge, resolve, verify:
   - `git fetch origin <default-branch>` then `git merge origin/<default-branch>`. "Already up
     to date" is a completed attempt, not a failed one — move straight to pushing.
   - Merge, never rebase: Phase 6 keeps appending commits to a public branch, and a merge commit
     never needs the forbidden force-push.
   - On conflict, resolve each hunk to the correct combined result — never a blanket
     `--ours`/`--theirs`. In files your change did not touch, take the default branch's side;
     where it touched the same lines as the fix, combine both intents (re-read the issue and the
     planner output if the intent is unclear — that is a stop condition, not a guess).
   - After every merge that brought commits in — clean, fast-forward or conflict-resolved —
     re-run the full gate: `npm test`, `npm run typecheck` and `npm run lint:changed`.
   - Record the pre-merge commit (`git rev-parse HEAD`) before each merge.
   - If conflict resolution fails while the merge is still in progress, run `git merge --abort`,
     fetch again (the default branch may have moved under you), and spend the second attempt.
     `git merge --abort` only aborts a merge in progress; it does not undo a completed one.
   - If the post-merge suite cannot be resolved after the merge has completed, restore the branch
     to the recorded pre-merge commit before fetching again and spending the second attempt —
     otherwise the retry reports "Already up to date" and walks straight to pushing unverified.
   - Two failed attempts: STOP — report the conflicting files and why resolution failed, and
     leave the branch unpushed.
4. Push the branch.
5. Open the PR:
   `gh pr create --title "<short title>" --body <body> --base <default-branch>`
   Body must include: a summary of the root cause and the fix, the list of changes, the tests
   added and how they were verified, the "Decided on default" list when any fork took its default,
   and the issue source's **Close line** on its own line so the issue closes on merge. End the body with: `🤖 Generated with [opencode](https://opencode.ai)`
6. Run the issue source's **After the PR** step with the PR URL.
7. Leave the worktree in place — it holds the branch the PR is from. Report the PR URL and the
   worktree path — the run continues into Phase 6, which owns the final summary.

Never force-push, never push directly to the default branch, never `git worktree remove` a
worktree whose PR is open.

## Phase 6 — Wait for GitHub review (max 5 rounds)

This repo has no CI — its PR checks are the automated reviewers themselves (CodeRabbit, Greptile),
and their completion is what posts the comments. Loop until no unaddressed comments remain; one
round = one wait, one fetch, one address cycle:

1. Wait for the review to land in one call: `gh pr checks <PR_NUMBER> --watch > <log> 2>&1` with
   `run_in_background`, then wait for its exit notification — never poll. "no checks reported" means
   the bots have not registered yet: wait once with `Monitor`, then watch again. Then fetch
   everything with full detail —
   review summaries and PR-level comments:
   `gh pr view <PR_NUMBER> --repo <owner/repo> --comments --json comments,reviews`, plus the
   line-level comments: `gh api repos/<owner>/<repo>/pulls/<PR_NUMBER>/comments`. Read the review
   summary bodies too, not just the line comments — a "Request changes" verdict is ground for
   another round even with no line comments.
2. Address the **line-level comments** by invoking the **`github-review-fix`** skill on this PR.
   It owns every mechanical step through to verifying each reply landed; the conversation keeps
   only its ambiguity gate (next step).
3. Handle what the skill hands back, and what it does not cover:
   - A comment that is ambiguous or contradicts the code, the issue, or another comment → its
     ambiguity gate: STOP and ask the user. Never invent a resolution.
   - **PR-level comments and review-summary bodies** (the skill covers line comments only): judge
     each point yourself. Fix what is real with the full Phase 3 discipline — RED test first,
     minimal fix, the focused suite + `npm run typecheck` + `npm run lint:changed` — and run one Phase 4
     reviewer round on the new diff before pushing.
4. Every addressed comment gets a reply saying what was fixed and how — never a bare
   "fixed in <sha>". github-review-fix posts its own; for the ones you handled:
   `gh pr comment <PR_NUMBER> --body "✅ Fixed in <sha> — <what changed and why>"`. Each push
   re-triggers the bots — return to step 1 for the next round.

Stop conditions — hand back to the user instead of improvising:

- **Contradiction**: two reviewers ask for mutually exclusive changes; a comment contradicts the
  issue's acceptance criteria; a comment demands scope far beyond the bug (rearchitecture, new
  feature, cross-module refactor); or following it would break a rule of this skill. Do not pick a
  side silently: quote each side, name its source, present the options with trade-offs, ask, and
  resume with the user's decision. Minor ambiguity you can resolve sensibly is not a contradiction
  — resolve it and keep going.
- **Five rounds with comments still open**: STOP. Report what remains and why.

**Stacked slices merge as they go green.** When the work is split into stacked PRs, merge a
slice's PR (`gh pr merge`, with the method the repo's merged PRs use — check `gh pr list --state
merged`) as soon as its CI, lanes and bot-review fixes are green; then rebase or retarget the next
slice's branch onto the default branch, and only then continue the next slice. Never keep more than
one unmerged slice under the one in progress.

Done means: zero unaddressed comments, the worktree still in place, `sh CLEANUP <N>` run, and the
PR unmerged (a stacked slice's PR is merged per the rule above; a final or single PR is the
maintainer's call). Final report: the PR URL, rounds spent, comments addressed, and anything
left unresolved with the reason.
