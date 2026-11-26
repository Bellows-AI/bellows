# Agent guide

Global instructions for every session in this image. Project-level `CLAUDE.md` / `AGENTS.md` files
in the mounted checkout take precedence over anything here.

**Tradeoff:** these guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think before coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity first

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.
- No magic strings. A value spelled in more than one place — an API error code, a label or header
  key, a value a client branches on — gets one named constant that every other site imports. If
  the repo already has a home for such values (a constants module, a lint rule banning the raw
  spelling), put new ones there. Tests may still pin the raw wire value on purpose.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the request.

## 4. Goal-driven execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
```

Strong success criteria let you loop independently.

## 5. Tool discipline

**Read the file before you edit it — every time.** Knowing the content is not the same as having
read it:

- Grep output, a subagent's report, and sandboxed script output do **not** count as a read.
- A file already in context because the harness injected it does **not** count either.
- After any command that rewrites files (`prettier`, `eslint --fix`, `lint-staged`,
  `git checkout/merge/stash`), an earlier read is stale. Read again before the next edit.

**Never use a relative `cd`.** Use absolute paths; the session's cwd may be a worktree or a
subdirectory rather than the repo root.

**Do not retry a command the permission settings deny — split a compound one first.** A command
wrapped in a `( … )` subshell, fed a heredoc, or chained with `;` or `&&` can be denied even when
every part is allowed, so run each part once on its own, unwrapped: `npm install`, not
`(npm install 2>&1 | tail -3)`. Only a plain command denied is a refusal — reach for the
non-destructive equivalent — `git restore`, `git merge --no-ff`, `trash` — or ask.

**Write a multi-line commit message in one command.** `git commit -F - <<'EOF'` … `EOF`, or a
quoted multi-line `git commit -m "…"`, both work; a temp message file is not needed.

**Check auth once, before a batch, not per call.** One probe up front, then re-authenticate, before
firing the rest.

## Testing

1. Apply DRY — avoid duplication, prefer shared utility packages.
2. Tests must be fully isolated from one another.
3. Do not clean up test data in integration scenarios.
4. Target mix: 25% unit, 70% integration, 5% E2E.
5. Never hardcode ids in database-connected (integration) tests.

**If you are about to take a shortcut — disabling a test, copy-pasting code, lowering an
expectation — ask first.**

## Code review checklist

1. Critical bugs (panic risks, nil dereferences)
2. Error handling patterns
3. Test coverage for the change
4. Linter clean
5. Build verification
6. Performance implications
7. Magic strings — a recurring value (error code, key, label) spelled raw instead of imported from
   its named constant

## Tooling

GitHub, Jira and Linear are covered by the `factory-github`, `factory-jira` and `factory-linear` skills, which
load on demand. Reach for them rather than improvising: `gh` for pull requests, reviews and checks; the
factory-jira skill's helper, `node /usr/local/share/factory-skills/factory-jira/jira.cjs`, for work items. Do
not use an Atlassian MCP server or `acli`. The factory-linear skill's helper,
`node /usr/local/share/factory-skills/factory-linear/linear.cjs`, is the path for Linear issues; not a Linear
MCP server or API key.

## Context discipline

An overgrown session triggers compaction, which costs minutes per cycle.

- **Search order for codebase questions: `grep` → `read`.** Find the place with `grep` first.
  Read targeted sections to understand failures and callers, or before editing. Avoid repeated
  reads of unchanged files unless needed for diagnosis.
- **Bound what a shell search can print.** When you shell out, narrow it (`--include`, a path
  prefix, `| head`) rather than running a bare `grep -rn` over the whole tree.
- **Trim what you print.** Summarize test and gate output (the summary lines, the failing files,
  `tail`) rather than pasting a full suite run into the session.
- **Run tests through the gates, not around them.** When the repository declares gates, a test
  run goes through `factory-gate` — filtered to your tests when the gate accepts a filter —
  because its answer is a bounded excerpt and the full log is stored, out of your context, for
  `--last --full` (redirect that to a file and grep it, never print it whole). A bare shell sweep
  of a suite the gates own floods the session and proves nothing. Your own shell only runs what
  no gate can — a repository with no gates at all (exit 3), a gate too long to run ad hoc (422) —
  and then the full output goes to a file you grep, never pasted into the session.
- **Iterate a failing test in a subagent.** A test↔fix loop you expect to take more than two
  runs — a failure whose cause you do not already know, a broad suite to verify — runs in a
  subagent (`general-purpose`, the Task tool): the subagent runs the loop under the same rule —
  its test runs through the gates where the repository declares them — and returns only the
  verdict per test, the remaining failing names with a one-line cause each, and the files it
  changed. The main session never carries the loop's raw output.
- **Three identical failures is a stop.** If the same test fails the same way three times, stop
  editing: re-read the failing assertion and the code under test, state the diagnosis in one
  line, then make one reasoned edit. Never blind string-replace a file you have not re-read.

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

## Commands in the environment image

Run any command in the repository's environment image — the container the gates use, in this
worktree — with `factory-exec`, the command as ONE quoted argument (it runs under `sh -c`):

```bash
factory-exec 'npx playwright test e2e/login.spec.ts'
```

It prints `{"exitCode":N,"output":"...","artifacts":[]}`. Use it for what only that image has: a browser, a toolchain
or client the image provides, inspecting or finishing the environment's setup, reproducing a failed
gate step. To check a change, prefer a declared gate. One run at a time, behind any gate already
running, capped at 10 minutes; it gets no GitHub token and never runs the pending setup first. The
request must fit 4096 bytes: put a longer script in a file and run that.
Exec runs are not gate evidence; never report an exec run as a passed gate.
Exit 3 means there is no environment image here (no `environment` declared, or a workflow step with
`gates: false`): run the command in your own shell instead. Exit 75 means no usable answer came: the
command may or may not have run, so check its effects before you ask again.
