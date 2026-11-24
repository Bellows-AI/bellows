---
name: factory-gates
description: Run a repository's verification gates (tests, lint, build checks declared in .bellows.yaml) in the shared environment image, and read their output. Use before finishing a task, after changes that could break CI, or whenever asked to "run the gates", "run the checks" or "verify with CI steps". Needs a repository that declares gates: `factory-gate` reports when it has none. Also runs any command in that environment image with `factory-exec` (a browser, the image's tooling, debugging its setup, reproducing a failed gate step).
---

# Verification gates

The repository you are working in may declare CI-style checks in `.bellows.yaml` — an environment
image and named commands (test, lint, build). They run in a separate container that shares this
workspace, so anything you have written to the tree is exactly what the gates see.

## Running a gate

```bash
factory-gate test
```

`factory-gate <name>` asks the gate server through this run's control socket (there is no URL or token
to hold) and prints the answer unchanged. A gate that accepts a filter takes `--filter <string>` after
the name (see below). It exits with 22 for an answer that is not a 2xx (its body is still printed, with
the status on stderr), with 3 when the repository declares no gates, and with 75 when no usable answer
came at all (the control socket is missing or refuses, the relay hung up, the gate run is not open yet,
the answer was cut short): that says nothing about the gate and is never a pass, so ask again.

`factory-gate --list` prints this run's tools as JSON, `{"tools":[...]}`: one `gate:<name>` per declared gate (its
`required` is `finish` or `on_demand`, `filter` whether it takes `--filter`, `timeout` in minutes) and `exec` when
`factory-exec` can run here; `{"tools":[]}` means no gates. Read it when you need the gate names.

A gate's answer is JSON: `{"verdict":"passed","exitCode":0,"output":"...","artifacts":[],"executionId":"..."}`.
`verdict` `passed` (exit code `0`) means the gate passed; `failed` means it failed, and `output` carries its tail — read it, fix what it names, run the gate again. A 503 with
`"retryable":true` means the run could not be recorded and did not start: call it again.

If the answer also carries `deadServices`, a service the repository declared (a database, a cache) has
died: the note names its exit, reason and last log lines. That is an environment fault you cannot fix
from the tree, and a gate that cannot reach the service (`ENOTFOUND`, connection refused) fails for it —
do not work around it by installing the service yourself; end with `FACTORY_BLOCKED:` and the note.

Run, read, fix, run again as often as the work needs: every answer is the gate's own result on the
tree as it is now. Before every push, run the declared gates that cover your change and fix a red
one before you push; the gates that run when you finish are no reason to skip them.

Your finish is gated: when you stop, every declared gate but the `on_demand` ones runs in full,
unfiltered, on the tree as it is. If one fails, its name and output come back to you in this same
session and you keep working: fix the cause, keeping the change as small as the fix allows, then
finish again. This repeats up to the executor's repair rounds; after the last one you may stop and the
task fails.
A gate you ran unfiltered that passed on exactly the tree you finish with, with nothing touched while it
ran, is reported as reused when you finish instead of running again; any later change runs it.
An unavailable gate (an environment failure) is reported, not a blocker; the pull request itself
(the factory-github skill) is held back by a gate only where the repository sets `policy: gates: required`. A task
that ends with a failing gate fails, but the work still ships as a draft; only a repository that sets `policy: gates:
required` in `.bellows.yaml` holds the publish back until they pass.

If `factory-gate` reports no gates (exit 3), this environment has no gates configured: say so and verify with
your own commands instead. Do not try to reach the gate server by any other route.

## Reading the last report

```bash
factory-gate test --last
```

`factory-gate <name> --last` answers the thread's last stored report of a declared gate without running it, whatever the
gate's `timeout`: `{"verdict":"failed","exitCode":1,"output":"...","artifacts":[],"last":true}`, the output cut to about 4 KiB. It is the
latest passed or failed report of that gate in this task, as of when this run started; a gate you ran ad hoc since is not in it.
A gate that has never run in this task answers 404 `no stored report for gate "<name>" in this thread` (exit 22, body printed):
say so instead of guessing. Takes no `--filter`.

The report's output is an excerpt: for a failed gate, its failure lines (`FAIL`, `×`, the `Test Files` / `Tests` summary)
first, then the tail. When the excerpt does not show what failed, read the run's whole output:

```bash
factory-gate test --last --full
```

`--last --full` answers the same JSON with `output` the gate's whole stored output (its last 512 KiB; `"truncated":true`
with a `cause` says it is not the whole output), read from the board. A run whose log the board no longer holds answers 404 (exit 22); a read that
could not be made answers a retryable 503 (exit 22) — try again, do not guess from the excerpt. Redirect it to a file and
search that (`factory-gate test --last --full > /tmp/test.json`) rather than printing it whole.

A follow-up that continues a run whose gates failed also starts with the failed gates' name, exit code and output after the
person's message. When you are told a gate failed (or "fix tests") and you cannot see why, read it with `--last` before you
guess at a fix; a long gate you cannot rerun here is exactly what it is for.

## Running any command: factory-exec

```bash
factory-exec 'npx playwright test e2e/login.spec.ts'
```

`factory-exec '<command>'` runs one command in the repository's environment image — the container the
gates use, in this worktree — and prints `{"exitCode":N,"output":"...","artifacts":[]}` (no verdict). Use it for what only that image
has: a browser, a toolchain or client the image provides, inspecting or finishing the environment's
setup, reproducing a failed gate step. To check a change, prefer a declared gate.

- Pass the command as ONE quoted argument; it runs under `sh -c`. The request must fit 4096 bytes
  (exit 2, "command too long"): put a longer script in a file in the worktree and run that file.
- One run at a time, behind any gate already running, capped at 10 minutes; whatever it started in the
  background is killed when it ends. It gets the gates' environment variables but no GitHub token, and
  it never runs the environment's pending `setup` first.
- Exec runs are not gate evidence; never report an exec run as a passed gate. Nothing records them,
  and `exitCode` is the command's own status.
- Exit 3 means there is no environment image here (the repository declares no `environment`, or this
  workflow step runs without one, as a `gates: false` node does): run the command in your own shell
  instead. Exit 75 means no usable answer came: the command may or may not have run, so check its
  effects before you ask again. Exit 22 is an answer that is not a 2xx (its body printed, the status
  on stderr).

## Rules

- Only gates the repository declares can run. The gate **name** goes in the request; you cannot
  send an arbitrary command. Read `.bellows.yaml` to see what is declared.
- Gates can write generated files to the shared workspace. The environment container stays warm —
  run one at any point to check partial progress.
- A gate whose `.bellows.yaml` entry sets `on_demand: true` is skipped when you finish and never
  fails the task: it runs only when you call it. Call it when your change touches what it checks.
- A gate whose `.bellows.yaml` entry sets `filter: true` accepts `--filter <string>` after the name
  (`factory-gate test --filter test/api/users.test.js`), up to 256 printable characters on one
  line. The string reaches the gate command as the environment variable `GATE_FILTER` for that one
  run; the command must read it, so check the gate's script before relying on it. Use it to run
  only the tests your change touches. A filter on a gate that did not opt in answers 422: run it
  without one. A filtered run is never evidence that the gate passed; the gates that run when you
  finish are always unfiltered.
- A gate whose `.bellows.yaml` entry declares `timeout:` above 10 (minutes) cannot run ad hoc: the
  call answers 422 and the gate runs only when you finish (an `on_demand` one not at all). Do not
  retry it; run its pieces (a build, one spec) with your own commands instead, and read its last stored report with `--last`.
- If a declared gate is still failing when you finish, say so plainly; never claim it passed.
