---
name: fix-local
description: The fix skill with Codex reviews — fix a GitHub issue end-to-end in an isolated worktree (fix-planner plan, TDD, PR, GitHub review loop), but the fix-planner's plan and the Phase 4 adversarial code review both go through the local Codex CLI (`codex exec`, read-only sandbox) instead of the reviewer subagent. Needs `codex` on PATH and logged in, so local machines only. Trigger phrases: "/fix-local", "fix this issue with codex review", "fix locally with codex".
---

# Fix a GitHub issue, Codex-reviewed

Read `<repo root>/.claude/skills/fix/SKILL.md` and run it exactly — every phase, rule, stop
condition, and the autonomy it demands — with the changes below. Where the two disagree, this file
wins; everything it does not mention stays as `fix` writes it.

## Phase 0 addition — Codex preflight

Before fetching the issue, check once: `command -v codex` and `codex login status`. Either failing →
STOP and tell the user (`codex login`, or run `/fix` instead). Never fall back to a subagent
silently: a second model's eyes are the point of this skill.

## Running Codex

Every review here is one `codex exec` in a read-only sandbox: a fresh session per round, a
different model from the one that wrote the plan or the code, briefed to break it rather than
approve it.

1. Pick STEM=`<scratchpad>/codex-<plan|code>-<issue>-r<N>` (any temp dir outside WORKTREE when no
   scratchpad is set) and write the brief, filled in, to `<STEM>.md`.
2. Run it with Bash `run_in_background` — it takes minutes — and wait for the exit notification;
   never poll:
   `sh HEAVY codex exec -C <WORKTREE> -s read-only --ephemeral --color never -o <STEM>.out - < <STEM>.md > <STEM>.log 2>&1`
   (HEAVY as `fix` defines it: the review queues for a host slot like any suite.)
3. A non-zero exit or an empty `.out` is a failed round, not a clean one: read the `.log`, retry
   once, then STOP and report.
4. Codex is a reviewer, not an authority. A finding the code disproves is rejected with a one-line
   reason; from round 2 on, the brief lists every earlier finding with its class and
   `fixed: <how, every instance>`, `rejected: <why>` or `deferred: #<issue>`.
5. From round 2 on, the brief also carries the sweep block (below) over every class accepted so
   far, and from round 3 on only a correctness or data-loss defect counts as a blocker. A round
   whose blockers all repeat an accepted class makes the next round sweep-only: the sweep block,
   no open hunt.

## Phase 2 addition — Codex plan review (max 2 rounds)

After the fix-planner returns and before its plan becomes the todo list, review the plan with the
plan brief below. Per round:

- A blocker the code confirms amends the plan: fix it yourself when it is local to a step;
  re-spawn the fix-planner with the finding when it disputes the root cause or the approach.
- A finding that exposes ambiguity in the issue itself is a `BLOCKER` under `fix` Phase 2: STOP and
  ask the user.
- A round with zero blockers ends the loop. After 2 rounds with blockers remaining: STOP and
  present the plan, the open findings and your analysis.

## Phase 4 replacement — Codex code review (max 3 rounds)

Per round, in WORKTREE:

1. Make the whole change visible as one diff: `git add -N <each new file>` (intent-to-add, so
   untracked files appear), then record BASE=`git merge-base HEAD origin/<default-branch>`.
2. Run the code brief below.
3. Triage as `fix` Phase 4 does: fix blockers and re-run the focused suite; nitpicks only if trivial.
4. A round with zero blockers ends the loop.

After 3 rounds with blockers remaining: STOP, exactly as `fix` Phase 4 says. Phase 6's "one Phase 4
reviewer round" for PR-feedback fixes means one round of this loop.

## The plan brief

```text
You are an adversarial reviewer of a fix plan. Another model wrote it before any code changed:
assume it is wrong until the code proves otherwise. Do not modify any file — read, search and run
read-only commands only.

Issue #<N>: <title>
<body, then each comment>

The plan:
<the fix-planner's output, verbatim>

<Rounds 2+ only — "Previous findings:" then each one with "fixed: <how>" or "rejected: <why>".
Confirm every fix holds, then hunt for new problems.>

Before judging, read the docs/ file that AGENTS.md's "Read before you touch" table maps to the
area. Then check the plan against the code in the current directory, in priority order:
- Root cause: trace the failing path yourself. Is the cause the plan names the real one, or does it
  patch a symptom?
- Reach: every caller, sibling path and executor the cause reaches — a second call site with the
  same bug, a counterpart AGENTS.md requires.
- The RED test: would it fail on today's code for the issue's reason, and pass only once the cause
  is fixed?
- Scope: steps beyond the issue, speculative abstractions, anything AGENTS.md forbids.
- Ambiguity: anything in the issue the plan settled by guessing.
- Hazards: the plan's Hazards section — a read, wait or destructive call it leaves undecided, or
  decided in a way the code contradicts.

Verify before reporting: a claim five seconds of reading would disprove is noise.

Output a numbered list. Each item: `blocker` or `nitpick`, the plan step or `file:line` it concerns,
one or two sentences on what is wrong and the evidence in the code; blockers add the change you
suggest. Nothing found: reply exactly "No blockers." No praise, no padding.
```

## The code brief

```text
You are an adversarial code reviewer. Another model wrote this change: assume it is wrong until the
code proves otherwise, and try to break it. Do not modify any file — read, search and run read-only
commands only.

The change is `git diff <BASE>` in the current directory (working tree against the base, new files
included). Before judging it, read the docs/ file that AGENTS.md's "Read before you touch" table maps
to the area the diff touches.

Issue #<N>: <title>
<body>

Approach: <one paragraph>

<Rounds 2+ only — "Previous findings:" then each one with "fixed: <how>" or "rejected: <why>".
Confirm every fix holds, then hunt for new problems.>

Hunt, in priority order:
- Correctness: name the input, state or ordering that makes the change misbehave — null/empty,
  boundaries, concurrent claims, a driver, runner or pod lost mid-step, unhandled error paths.
- Tests: would the new test fail on the pre-fix code? Does it pin the issue's behavior or a
  tautology? Isolated from other tests, with no hardcoded ids, ports or paths?
- Scope: every changed line traces to the issue; flag drive-by refactors and speculative
  abstractions.
- Repo rules: anything AGENTS.md or the area's docs/ file forbids or requires.
- Security: committed secrets, injection, errors leaking internals.

Name each finding's class, and report every instance of that class in the code the diff adds or
calls — never only the first. A defect in pre-existing code the diff does not call goes under
"Follow-up", never as a blocker.

<Rounds 2+ only — the sweep block: "Accepted classes:" then each class. For each, list every
remaining instance, or state "none remain".>

Verify before reporting: a claim five seconds of reading would disprove is noise.

Output a numbered list. Each item: `blocker` or `nitpick`, its class, `file:line`, one or two
sentences on what breaks and the concrete input that breaks it; blockers add the fix you suggest.
Then "Follow-up:" with any out-of-path defects. Nothing found: reply exactly "No blockers." No
praise, no padding.
```
