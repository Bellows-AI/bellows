---
name: batch-control
description: Plan and drive a Factory batch from a local session — turn an epic into ordered stages of parallel tasks, import and validate the plan, start it, watch it to the end and act on whatever needs a person (a PR to review, a question to answer, a task to retry). Use when the user says "run this as a batch", "plan a batch", "split this epic into tasks on Factory", "start the batch", "wait for the batch", "batch report", "retry task X in the batch", or "cancel the batch". Single tasks stay with task-control; "why did it fail" stays with investigate-task.
---

# Drive a batch from a local session

A batch is ordered stages of parallel tasks; each task is an ordinary task thread with its own PR.
The board schedules it — closing this session, or the CLI, cancels nothing. This skill writes the
plan and reacts to what the board reports; it never schedules, merges or answers on its own.

Setup, discovery and the CLI rules are the `task-control` skill's sections 1 and 2: the same
`FACTORY_URL` and `FACTORY_TOKEN`, the same `GET /api/repos` and `GET /api/workspace/executors`
reads before a plan names a repo or an executor, the same ONE npm layer
(`npm run dev -w cli -- batch …`). Batch routes take a person's credential only: a `fat_`
personal token, never an `oat_` organization token or the driver's worker token.

## 1. Write the plan

Start from `plan.example.json` beside this file and keep its shape. The contract is
`core/src/batch-plan.ts`; what matters when splitting work:

- **Stage order is the only dependency.** Tasks in one stage run in parallel and must not depend on
  each other; a task that needs another's merged change goes in a later stage. There is no
  `dependsOn` — any unknown field is refused.
- **Each task is one PR.** `objective` is the command the agent runs; `acceptance` and
  `verification` state how a reviewer tells it is done. Up to 4000 characters each.
- Keys (`targets`, `stages`, `tasks`) match `^[a-z0-9][a-z0-9-]*$`, at most 40 characters, unique.
- `completion` is `{ "kind": "pr" }` for code changes. `{ "kind": "accepted", "condition": "…" }`
  is only for a task that changes no code, and a person must accept it.
- `policy` is `human` (the board opens PRs; people merge them) or `automerge` (the board merges
  once GitHub's requirements pass). A stage may override it. Default to `human` unless the user
  asks for automerge.
- Bounds: 10 targets, 20 stages, 20 tasks per stage, 100 tasks; `concurrency` 1..20,
  `infraRetries` and `repairs` 0..5, `timeLimitMinutes` 1..1440.

**What `start` refuses today** — a plan that validates structurally can still be refused at start
with `409 BATCH_UNSUPPORTED`: more than one target (`multi_target`), a target `branch` other than
the repository's default (`non_default_branch`), or `automerge` on a board without a GitHub
installation (`automerge`). Write one target, omit `branch`.

Show the user the stages and tasks, and confirm the repo, the split and the policy before import.
Every task spends real money and opens a real PR.

## 2. Import, validate, revise

```bash
npm run dev -w cli -- batch import --file plan.json --idempotency-key <key> --json   # POST /api/batches
npm run dev -w cli -- batch validate <id> --json                                    # POST /api/batches/<id>/validate
npm run dev -w cli -- batch update <id> --version <n> --file plan.json --json       # PUT /api/batches/<id>
npm run dev -w cli -- batch inspect <id> --json                                     # GET /api/batches/<id>
```

Import answers the draft's `id` and `version`. `400 BAD_BATCH` lists every problem by its path
(`stages[0].tasks[1].target`); fix them all, then import again. Validate runs the launch checks —
repository visibility, default branch, capability, executors — writes nothing, and shows the plan
as start would freeze it. Update replaces the whole draft at the version you last read;
`409 BATCH_STALE` means someone else wrote it: inspect, merge by hand, update at the new version.

## 3. Start

Confirm with the user first — start freezes the plan and dispatches the first stage.

```bash
npm run dev -w cli -- batch start <id> --version <n> --idempotency-key <key> --json  # POST /api/batches/<id>/start
```

Lost answer (exit `7`, or `1` with the "may have been applied" hint): repeat with the same key.
`409 BATCH_STARTED` means it already started.

## 4. Watch

```bash
npm run dev -w cli -- batch wait <id> --timeout 1800 --json
npm run dev -w cli -- batch report <id> --json                                      # GET /api/batches/<id>/report
```

`wait` only watches. Its exit code says what to do next:

| Exit | Meaning | Next |
| --- | --- | --- |
| `0` | every task succeeded and passed its gate | report, done |
| `3` | the wait budget ran out; the batch is still going | wait again |
| `6` | a task needs a person | read the report, act on section 5 |
| `4` | a task failed and needs a decision | read the report, act on section 5 |
| `5` | cancelled, or the time limit expired | report what merged; a new batch for the rest |
| `7` | board unreachable | wait again once it answers |

## 5. Act on the report

Each report task carries `waitReason`, `attention` and `next` — the one supported next step. Do
what `next.action` says and nothing else:

- `merge` — a `human` stage PR at `next.url` needs review and merge **by a person**. List the URLs
  for the user. The board verifies the merge itself and continues; never merge for them.
- `answer` — the agent asked a question (`next.path` names the job and question). Relay it to the
  user (`npm run dev -w cli -- job questions <job>` shows its prompts), then send their answer with
  `npm run dev -w cli -- job answer <job> <question> --answer <text>`, one `--answer` per prompt
  in that order. Never invent an answer.
- `accept` — an `accepted`-completion task finished; show its `condition` and the run's result to
  the user and, on their word, `npm run dev -w cli -- batch accept <id> <task>`
  (`POST /api/batches/<id>/tasks/<task>/accept`).
- `retry` — failed, budget spent, or its PR closed. Read why first (the `investigate-task` skill on
  `job`), confirm with the user, then `npm run dev -w cli -- batch retry <id> <task>`
  (`POST /api/batches/<id>/tasks/<task>/retry`). A configuration failure needs the configuration
  fixed, not a retry.
- `wait` — the board is still on it, recovery included; go back to section 4.
- `new_batch` — the batch is fenced; the remaining work needs a new plan.

Sibling tasks keep running while one waits on a person.

## 6. Cancel

Destroys work in progress. **Confirm with the user, quoting the batch id and title.**

```bash
npm run dev -w cli -- batch cancel <id>                                             # POST /api/batches/<id>/cancel
```

Cancel fences first, then stops moving tasks; merges that land afterwards are still recorded.

## Reporting back

Name the batch id, the board's `state`, merged and open PRs, and each task that needs someone with
its `next` step. Exit `3` is "still running", never a verdict.
