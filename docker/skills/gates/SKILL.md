---
name: gates
description: Run a repository's verification gates (tests, lint, build checks declared in .bellows.yaml) in the shared environment image, and read their output. Use before finishing a task, after changes that could break CI, or whenever asked to "run the gates", "run the checks" or "verify with CI steps". Requires BELLOWS_GATE_URL and BELLOWS_GATE_TOKEN to be set.
metadata:
  requires-tools: curl
---

# Verification gates

The repository you are working in may declare CI-style checks in `.bellows.yaml` — an environment
image and named commands (test, lint, build). They run in a separate container that shares this
workspace, so anything you have written to the tree is exactly what the gates see.

## Running a gate

```bash
curl -sf -X POST "$BELLOWS_GATE_URL/run" \
    -H "authorization: Bearer $BELLOWS_GATE_TOKEN" \
    -H "content-type: application/json" \
    -d '{"gate":"test"}'
```

The answer is JSON: `{"exitCode":0,"output":"...","executionId":"..."}`. `exitCode` `0` means the gate passed; anything
else failed, and `output` carries its tail — read it, fix what it names, run the gate again. A 503 with
`"retryable":true` means the run could not be recorded and did not start: call it again.

If the answer also carries `deadServices`, a service the repository declared (a database, a cache) has
died: the note names its exit, reason and last log lines. That is an environment fault you cannot fix
from the tree, and a gate that cannot reach the service (`ENOTFOUND`, connection refused) fails for it —
do not work around it by installing the service yourself; end with `FACTORY_BLOCKED:` and the note.

Run, read, fix, run again as often as the work needs: every answer is the gate's own result on the
tree as it is now. Before every push, run the declared gates that cover your change and fix a red
one before you push; the gates that run when you finish are a backstop, not a reason to skip them.
A gate you ran unfiltered that passed on exactly the tree you finish with, with nothing touched while it
ran, is reported as reused when you finish instead of running again; any later change runs it.
An unavailable gate (an environment failure) is reported, not a blocker; the pull request itself
(the github skill) is held back by a gate only where the repository sets `policy: gates: required`. The declared gates also run when you finish and a failing one fails
the task, but the work still ships as a draft; only a repository that sets `policy: gates:
required` in `.bellows.yaml` holds the publish back until they pass.

If `BELLOWS_GATE_URL` is unset, this environment has no gates configured: say so and verify with
your own commands instead. Do not guess the URL.

## Rules

- Only gates the repository declares can run. The gate **name** goes in the request; you cannot
  send an arbitrary command. Read `.bellows.yaml` to see what is declared.
- Gates can write generated files to the shared workspace. The environment container stays warm —
  run one at any point to check partial progress.
- A gate whose `.bellows.yaml` entry sets `on_demand: true` is skipped when you finish and never
  fails the task: it runs only when you call it. Call it when your change touches what it checks.
- A gate whose `.bellows.yaml` entry sets `filter: true` accepts `"filter":"<string>"` in the request
  (`-d '{"gate":"test","filter":"test/api/users.test.js"}'`), up to 256 printable characters on one
  line. The string reaches the gate command as the environment variable `GATE_FILTER` for that one
  run; the command must read it, so check the gate's script before relying on it. Use it to run
  only the tests your change touches. A filter on a gate that did not opt in answers 422: run it
  without one. A filtered run is never evidence that the gate passed; the gates that run when you
  finish are always unfiltered.
- A gate whose `.bellows.yaml` entry declares `timeout:` above 10 (minutes) cannot run ad hoc: the
  call answers 422 and the gate runs only when you finish (an `on_demand` one not at all). Do not
  retry it; run its pieces (a build, one spec) with your own commands instead.
- If a declared gate is still failing when you finish, say so plainly; never claim it passed.
