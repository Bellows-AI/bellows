# Agent guide

Global instructions for every run in this image. Project-level `AGENTS.md` / `CLAUDE.md` files in
the mounted checkout take precedence over anything here.

**Tradeoff:** these guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 0. Board tasks: how the work lands

You are running as a headless task on the factory board. Nobody is watching a terminal — never
stop to ask; unanswered questions go in the final report (§5).

- Work happens in the checkout mounted at your working directory — your run's own worktree,
  branched off the remote default, one per task, so concurrent tasks never share a tree. Never
  commit to the default branch: work on the branch your worktree is on, or create a task branch —
  `fix/<issue-number>` when the task names an issue, otherwise `task/<short-slug>`.
- Commit as you go. One logical change per commit, messages in the imperative mood, the issue
  reference (e.g. `(#12)`) in the commit that closes the task.
- Before every push, run the declared gates (below) that cover your change, filtered to your tests
  when the gate accepts a filter, and fix a red one before you push. An unavailable gate is
  reported, not a blocker.
- Finish means: the work committed on the task branch and the tree clean. You may push the branch
  and open or update the pull request yourself (`gh pr create`); the board's own end-of-run
  publish reuses that same pull request. Never say a gate passed that did not.

## 1. Think before coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask in the final message.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.

## 2. Simplicity first

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what the task asked for.
- No abstractions for single-use code.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.
- No magic strings. A value spelled in more than one place — an API error code, a label or header
  key, a value a client branches on — gets one named constant that every other site imports. If
  the repo already has a home for such values (a constants module, a lint rule banning the raw
  spelling), put new ones there. Tests may still pin the raw wire value on purpose.

## 3. Surgical changes

**Touch only what the task requires. Clean up only your own mess.**

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match the existing style of the file, even if you'd do it differently.
- Every changed line should trace back to the task.

## 4. Review before you finish

Read your own diff as a reviewer would, and fix what it finds:

1. Critical bugs (crash risks, null dereferences)
2. Error handling patterns
3. Test coverage for the change
4. Linter clean
5. Build verification
6. Performance implications
7. Magic strings — a recurring value (error code, key, label) spelled raw instead of imported from
   its named constant

## 5. Finish with a report

The final message is the only thing a human reads: state what you changed, what you verified, and
anything you could not do.

## Tooling

- Reach for `gh` for GitHub (pull requests, reviews, checks) rather than raw API calls.
- Reach for `curl` on `$JIRA_API` for Jira work items, as the `jira` skill spells it; not `acli`.
- Both start unauthenticated; they read credentials from the environment or config the caller
  provides. If a credential is missing, say so instead of working around it.

## Context discipline

An overgrown session triggers compaction, which costs minutes per cycle.

- **Search order for codebase questions: `grep` → `read`.** Find the place with `grep` first.
  `read` is for a file you are about to edit — not for open-ended investigation, and never re-read
  a file you have not changed.
- **Bound what a shell search can print.** When you shell out, narrow it (`--include`, a path
  prefix, `| head`) rather than running a bare `grep -rn` over the whole tree.
- **Trim what you print.** Summarize test and gate output (the summary lines, the failing files,
  `tail`) rather than pasting a full suite run into the session.

## Infrastructure access

The environment and the job's declared services carry the infrastructure — on `127.0.0.1` only a
declared service listens. Before connecting to a database or any other backing service:

- **Look up the injected env variables first** (`printenv`). The board resolves the author's
  scoped variables at claim time and injects them into this container; a `DATABASE_URL` names the
  host to connect to. A refused connection on `127.0.0.1` at a port no declared service uses means
  "probed the wrong address", not "nothing is running" — there is no host port publishing here.
- **Declared services are reached by their declared name.** A `services:` list in the checkout's
  `.bellows.yaml` starts one container per entry beside this one for as long as the job runs, and
  the service `name` is its hostname, which resolves to `127.0.0.1` — connect to `db:5432`, not to
  a guessed address. Services start with no health wait: a refused first connect may be a service
  still booting, so retry briefly before declaring it down.

## Verification gates

The repository may declare CI-style checks in `.bellows.yaml` — named commands (`test`, `lint`,
build) that run in a separate container sharing this workspace. When `BELLOWS_GATE_URL` and
`BELLOWS_GATE_TOKEN` are set, run one with `factory-gate`:

```bash
factory-gate test
```

The answer is JSON, `{"exitCode":0,"output":"..."}`. `exitCode` 0 means the gate passed; otherwise read `output`, fix what it names, and run it again.
Only gates `.bellows.yaml` declares can run — the request carries a gate NAME, never a command.
A gate that sets `on_demand: true` is skipped when you finish and never fails the task: it runs
only when you call it, so call it when your change touches what it checks.
A gate that sets `filter: true` accepts `--filter <string>` after the name (up to 256 printable
characters, one line): the string reaches the gate command as the environment variable
`GATE_FILTER` for that one run, so run only the tests you changed with it. A filter on a gate that
did not opt in answers 422. A filtered run is never evidence that the gate passed, and the gates
that run when you finish are always unfiltered.
A gate that declares `timeout:` above 10 (minutes) answers 422 and runs only when you finish (an
`on_demand` one not at all): do not retry it; run its pieces with your own commands instead.
If `BELLOWS_GATE_URL` is unset there are no gates here: verify with your own commands instead.
