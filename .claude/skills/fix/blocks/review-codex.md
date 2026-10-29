# Reviewer: Codex

Swaps the local Codex CLI in for the plan check and the Phase 4 code review of the `fix` skill.
Where this block and `fix` disagree, this block wins.

## Phase 0 addition — Codex preflight

Before fetching the issue, check once: `command -v codex` and `codex login status`. Either failing →
STOP and tell the user (`codex login`, or run `/fix` instead). Never fall back to a subagent
silently: a second model's eyes are the point of this block.

## Running Codex

Every review here is one `codex exec` in a read-only sandbox: a fresh session per round, a
different model from the one that wrote the plan or the code, looking for real defects — not for
something to say.

1. Pick STEM=`<scratchpad>/codex-<plan|code>-<N>-r<round>` (any temp dir outside WORKTREE when no
   scratchpad is set) and write the brief, filled in, to `<STEM>.md`.
2. Run it with Bash `run_in_background` — it takes minutes — and wait for the exit notification;
   never poll:
   `sh HEAVY codex exec -C <WORKTREE> -s read-only --ephemeral --color never -o <STEM>.out - < <STEM>.md > <STEM>.log 2>&1`
   (HEAVY as `fix` defines it: the review queues for a host slot like any suite.)
3. A non-zero exit or an empty `.out` is a failed round, not a clean one: read the `.log`, retry
   once, then STOP and report.
4. Codex is a reviewer, not an authority. No major issue means the round passes. In every round
   only a major defect counts as a blocker: a correctness or data-loss defect on the change's path,
   with a concrete input or state that triggers it in normal use, that ships a wrong or incomplete
   fix, or a break of an AGENTS.md rule. Everything else is a nitpick — rare edge cases, defensive
   checks, hardening, test polish, style — taken if trivial, otherwise left or deferred, and never a
   reason for another round. A finding the code disproves is rejected with a one-line reason.
5. Round 2 is a check, not a new hunt: its brief lists every round-1 blocker with its class and
   `fixed: <how, every instance>`, `rejected: <why>` or `deferred: <ref>`, plus the sweep block
   (below) over every accepted class.

## Phase 2 addition — Codex plan review (1 round)

After the fix-planner returns and before its plan becomes the todo list, review the plan once with
the plan brief below.

- A blocker the code confirms amends the plan: fix it yourself when it is local to a step;
  send it back to the fix-planner (`fix` Phase 2, revise) when it disputes the root cause or the
  approach.
- A finding that exposes ambiguity in the issue itself is a `BLOCKER` under `fix` Phase 2: STOP and
  ask the user. A design fork it exposes takes the recommended default per `fix` Phase 2.
- Before this review, run `fix` Phase 2's hazard check on the plan, so Codex spends its round on new
  problems.

## Phase 4 replacement — Codex code review (max 2 rounds)

Per round, in WORKTREE:

1. Make the whole change visible as one diff: `git add -N <each new file>` (intent-to-add, so
   untracked files appear), then record BASE=`git merge-base HEAD origin/<default-branch>`.
2. Run the code brief below.
3. Triage as `fix` Phase 4 does: fix blockers and re-run the focused suite; nitpicks only if trivial.
4. A round with zero blockers ends the loop.

After 2 rounds with blockers remaining: STOP, exactly as `fix` Phase 4 says. Phase 6's "one Phase 4
reviewer round" for PR-feedback fixes means one round of this loop.

## The plan brief

```text
Review this fix plan, written before any code changed. Do not modify any file — read, search and
run read-only commands only.

Issue <REF>: <title>
<body, then each comment>

The plan: read <PLAN, the plan file's absolute path>

Read the docs/ file that AGENTS.md's "Read before you touch" table maps to the area, then check:
- Root cause: is the cause the plan names the real one, or a symptom?
- Reach: a second call site with the same bug, or an executor counterpart AGENTS.md requires.
- The RED test: would it fail on today's code for the issue's reason?
- Ambiguity: anything in the issue the plan settled by guessing.

Report only what the code confirms. A blocker is a major issue only: a plan that would ship a wrong
or incomplete fix. Edge cases, hardening, style, naming and preferences are nitpicks.

Output a numbered list. Each item: `blocker` or `nitpick`, the plan step or `file:line`, one or two
sentences with the evidence; blockers add the change you suggest. Nothing found: reply exactly
"No blockers."
```

## The code brief

```text
Review this change for real defects. Do not modify any file — read, search and run read-only
commands only.

The change is `git diff <BASE>` in the current directory (working tree against the base, new files
included). Read the docs/ file that AGENTS.md's "Read before you touch" table maps to the area first.

Issue <REF>: <title>
<body>

Approach: <one paragraph>

<Round 2 only — "Previous findings:" then each one with its class and "fixed: <how>",
"rejected: <why>" or "deferred: <ref>". Then the sweep block: "Accepted classes:" then each
class. Confirm each fix holds and list any remaining instance of each class, or state "none remain".
Do not hunt for new problems.>

Look for:
- Correctness: a concrete input, state or ordering that makes the change misbehave or lose data.
- Tests: does the new test fail on the pre-fix code and pin the issue's behavior?
- Repo rules: anything AGENTS.md or the area's docs/ file explicitly forbids or requires.

A blocker is a major issue only: a correctness or data-loss defect you can trigger with a concrete
input in normal use, or a break of an AGENTS.md rule; give its class and report every instance in
the code the diff adds or calls. Rare edge cases, defensive checks, hardening, test polish, style,
naming, refactors and hypotheticals with no concrete trigger are nitpicks at most. No major issue:
reply "No blockers." even if you list nitpicks. A defect in pre-existing code the diff
does not call goes under "Follow-up", never as a blocker.

Output a numbered list. Each item: `blocker` or `nitpick`, its class, `file:line`, one or two
sentences on what breaks and the input that breaks it; blockers add the fix you suggest. Then
"Follow-up:" with any out-of-path defects. Nothing found: reply exactly "No blockers."
```
