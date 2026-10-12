# Batches

A batch is an ordered plan of stages of parallel tasks across one or more repository targets: a
draft an org member edits whole, validates, then starts. Start freezes the resolved plan; the
scheduler then runs one stage at a time, its tasks in parallel, as ordinary job threads. A task's
gate passes on a merged PR (a person's, or the board's in an `automerge` stage) or a person's
recorded acceptance. No driver or runner change.

| Concern | Code | Test |
| --- | --- | --- |
| Plan contract v1: types, bounds, `validateBatchPlan`, `resolveBatchPlan`, `batchExecutionCapability` | `core/src/batch-plan.ts` | `core/test/batch-plan.test.ts` |
| Error codes (`BAD_BATCH`, `BATCH_STALE`, `BATCH_STARTED`, `BATCH_UNSUPPORTED`, `BATCH_TASK_NOT_ACCEPTABLE`, `BATCH_NO_DEFAULT_BRANCH`, `BATCHES_UNAVAILABLE`) | `core/src/error-codes.ts` | `core/test/error-codes.test.ts` |
| Schema: `batch`, `batch_target`, `batch_stage`, `batch_task`, `batch_idempotency`, the immutability triggers | `server/migrations/059_batches.sql` | `server/test-db/batch-store.test.ts` |
| Store bound to `orgId`: create, get, list, replace, start | `server/src/db/batch-store.ts`, `batch-store-rows.ts`, `batch-store-types.ts` | `server/test-db/batch-store.test.ts` |
| Idempotency records for create and start | `server/src/db/batch-store-idempotency.ts` | `server/test-db/batch-store.test.ts` |
| Runtime tables: `batch_attempt`, `batch_decision`, `cancelled_at`, `completed_at` | `server/migrations/060_batch_runtime.sql` | `server/test-db/batch-dispatch.test.ts` |
| Pure readiness, capacity, advancement and wait decisions | `core/src/batch-schedule.ts` | `core/test/batch-schedule.test.ts` |
| Scheduling transactions: reconcile, retry, cancel, accept | `server/src/db/batch-store-schedule.ts` | `server/test-db/batch-dispatch.test.ts` |
| Periodic and startup reconcile | `server/src/batch-reconciler.ts`, `server/src/orgs.ts` | `server/test/batch-reconciler.test.ts` |
| Roots created in the scheduler's transaction; remove/reopen refuse a batch thread | `server/src/db/job-store-actions.ts` | `server/test-db/batch-dispatch.test.ts` |
| Human PR gate: `judgeTaskGate` (pure), `judgeGates` (reads `job_pr` + `pr_merge` per pass) | `core/src/batch-schedule.ts`, `server/src/db/batch-store-gates.ts` | `core/test/batch-schedule.test.ts`, `server/test-db/batch-dispatch.test.ts` |
| Gate evidence: `batch_acceptance` | `server/migrations/061_batch_acceptance.sql` | `server/test-db/batch-dispatch.test.ts` |
| Recovery: failure classification, backoff, repair command, attention reasons, next action | `core/src/batch-recovery.ts` | `core/test/batch-recovery.test.ts` |
| Recovery state: budgets, `deadline_at`/`expired_at`, `attention`, `recovery`, `not_before`, attempt kinds | `server/migrations/062_batch_recovery.sql`, `server/src/db/batch-store-repair.ts` | `server/test-db/batch-dispatch.test.ts` |
| PR observation: assessment, fingerprint, backoff (pure); GitHub read and its typed errors | `core/src/batch-observation.ts`, `server/src/github/pr-read.ts` | `core/test/batch-observation.test.ts`, `server/test/github.pr-read.test.ts` |
| Observation rows, leases, supersession, hints; observer loop and merge hand-off | `server/migrations/063_batch_pr_observation.sql`, `server/src/db/batch-store-observation.ts`, `server/src/batch-pr-observer.ts` | `server/test-db/batch-pr-observation.test.ts` |
| Automerge: merge decision, fresh recheck, provider answers, stage verification (pure) | `core/src/batch-merge.ts` | `core/test/batch-merge.test.ts` |
| Merge intents, the per-target slot, stage verification rows | `server/migrations/064_batch_merge.sql`, `server/src/db/batch-store-merge.ts` | `server/test-db/batch-merge.test.ts` |
| Merger loop (runs after each observe pass); GitHub merge and branch reads | `server/src/batch-merger.ts`, `server/src/github/pr-merge.ts`, `server/src/github/pr-read.ts` | `server/test-db/batch-merge.test.ts`, `server/test/github.pr-merge.test.ts` |
| Morning report, built from rows on every read | `server/src/db/batch-store-report.ts` | `server/test-db/batch-dispatch.test.ts` |
| Routes (wait, retry, cancel, accept, report) | `server/src/routes/batches.ts`, `batch-handlers.ts` | `server/test/routes.batches.test.ts` |
| Launch checks shared by `validate` and `start` | `server/src/routes/batch-launch.ts` | `server/test/routes.batches.test.ts` |
| Request envelope, org context, refusals | `server/src/routes/batch-http.ts` | `server/test/routes.batches.test.ts` |
| Auth wall: human credentials only | `server/src/auth/plugin.ts` | `server/test/auth.enforcement.test.ts` |
| CLI client: `factory batch …`, draft round-trip, wait exit codes | `cli/src/batch.ts`, `batch-commands.ts`, `batch-render.ts` | `cli/test/batch.test.ts` |
| Web: list, draft composer, monitor, human-gate and task backlink | `web/src/pages/Batch*Page.tsx`, `web/src/panels/Batch*.tsx`, `web/src/api/useBatches.ts`, `web/src/batch-model.ts` | `web/test/batch-model.test.ts`, `e2e/batches.spec.ts` ([design-system/batches.md](design-system/batches.md)) |
| In-memory store double for the offline route tests | `server/test/helpers-batch-store.ts` | `server/test/routes.batches.test.ts` |

## Invariants

- **Stage order is the only dependency model.** An unknown field (`dependsOn` above all) is
  refused at every level of the plan, never ignored. `core/test/batch-plan.test.ts`.
- **Structural validity is independent of execution capability.** A two-repository plan is valid,
  persists and round-trips; only `start` and `validate` refuse it, with `409 BATCH_UNSUPPORTED` and
  `reason` `multi_target`, `non_default_branch` (checkout and verification are default-branch only;
  remaining work is tracked under #233) or `automerge` (only a board with no GitHub installation).
  `server/test/routes.batches.test.ts`.
- **The schema encodes no runtime limit:** no uniqueness on `repo`, no single-target constraint.
  A task's target is a composite foreign key into its own batch's targets, and `(org_id,
  root_job_id)` is unique, so one thread backs at most one task and a task's thread is set once.
  `server/test-db/batch-store.test.ts`.
- **A draft write and the freeze race on `(org_id, id, version, status = 'draft')`.** Start takes
  the row lock, so exactly one of a concurrent start and `PUT` wins and the frozen plan is the
  version that won. `server/test-db/batch-store.test.ts`.
- **Freeze resolves in place** — an explicit branch per target, a target per task, a policy per
  stage, the executor stamped — and the 059 triggers refuse every later write to those columns;
  the runtime columns (`root_job_id`, `execution`, `pr`, `gate`, `wait_reason`) stay writable.
  `server/migrations/059_batches.sql`, `server/test-db/batch-store.test.ts`.
- **Launch checks run in one order, for `validate` and `start` alike, and write nothing:**
  structure, installation visibility per target (`checkReposVisible`), default-branch resolution,
  capability, executors. A replayed `start` answers before any of them.
  `server/src/routes/batch-launch.ts`, `server/test/routes.batches.test.ts`.
- **Human credentials only.** No batch path is a worker route or on the organization-token
  allowlist, and the org comes from the credential: a body field naming `org` or `status` is
  refused. `server/test/auth.enforcement.test.ts`.
- **Every scheduling write runs under the batch row's `for update` lock, and each decision is
  unique by `batch_decision.key`** (`launch:<task>:<attempt>`, `advance:<stage>`, `complete`,
  `cancel`), so competing scheduler processes, a duplicate event and a restart launch and advance
  once, and the concurrency limit counts queued and running tasks, retries included.
  `server/test-db/batch-dispatch.test.ts`.
- **A task is accepted only when its run succeeded AND its gate passed, and a gate passes only
  with a `batch_acceptance` row:** `pr_merged`, written by the reconcile pass when the task's
  recorded PR is merged (matched on repo AND number, base branch equal to the task's target, merge
  observed after the current attempt began), or `accepted`, written by the accept route for an
  `accepted`-completion task. A run's verdict never satisfies the gate, and Done, remove, reopen
  and a PR-merge close all refuse a batch thread. Evidence is judged from durable rows on every
  pass, so a merge before the verdict, a duplicate delivery and a restart converge, and a
  cancelled or finished batch judges nothing. The next stage starts only after every required task
  of the active stage is accepted. `core/test/batch-schedule.test.ts`,
  `server/test-db/batch-dispatch.test.ts`.
- **Limits of the human gate:** a merge after which more commits were pushed is not detected;
  accept needs a human org member, not repository write access. `server/src/db/batch-store-gates.ts`.
- **Automerge asks, GitHub decides; a `human` stage issues zero merge requests.** The intent
  (`batch_merge`) is written under the batch lock before the request, bound to the observed head and
  re-read just before it: a moved head, retarget or lost requirement sends nothing. A refusal parks
  the task as `attention` and is asked again only for a new observation revision; a requirement is
  never bypassed. `core/test/batch-merge.test.ts`, `server/test-db/batch-merge.test.ts`.
- **One unresolved merge per repository and target, across batches** (`batch_merge_slot_idx`). A
  timeout or a lapsed lease is `uncertain` and read back from the PR (merged: recorded, never
  repeated; open: `lapsed`, retried after backoff). The cancel/expiry fence is re-read before the
  send; an accepted request is still recorded. `server/test-db/batch-merge.test.ts`.
- **An automerge stage advances only on a passed combined verification:** every merged change is on
  the target's tip and its required checks pass. Anything unreadable waits, a failure is reported
  (`verification`) and re-read until it passes, a fenced batch is never verified.
  `core/test/batch-merge.test.ts`, `server/test-db/batch-merge.test.ts`.
- **Limits of automerge:** merge queues are not proven (a queue answers 405 and the task parks), the
  method is `squash`, a repository with no checks never verifies, stage progression is default-branch
  only. `core/src/batch-merge.ts`, `core/src/batch-plan.ts` (`batchExecutionCapability`).
- **A task's PR is observed from GitHub, never inferred from `failure_kind`.** A row is bound to
  (repo, PR number, attempt) and names the head its checks ran on and the target a conflict was
  judged against; only a confirmed failing required check or conflict is `repairable`, and a new
  attempt deletes the row. A read commits only while it holds its lease and the binding stands;
  `revision` bumps only when the `fingerprint` changes, so #581 acts once per fingerprint.
  `core/test/batch-observation.test.ts`, `server/test-db/batch-pr-observation.test.ts`.
- **Webhooks hint, the observer decides:** a delivery marks rows `stale` and due, never reads;
  polling is 60 s, backs off to 15 min, honors Retry-After and spends no execution budget. An
  observed merge lands in `pr_merge` like a delivered one, even in a cancelled or expired batch,
  which it never revives. Mocks do not prove merge queues, protection only an admin token reads
  (unreadable is `unknown`) or an App lacking `Checks: read`. `server/test/webhook.batch-observation.test.ts`.
- **Recovery is bounded and counted from durable rows.** `infraRetries`, `repairs` and
  `timeLimitMinutes` freeze at start; a task's budget is the count of its `infra_retry` and `repair`
  `batch_attempt` rows, so a restart cannot reset it, and a manual retry spends none. An
  infrastructure failure retries in its own thread after a bounded backoff; a failed gate, publish
  or helper is repaired by an ordinary follow-up of the thread head, so the task keeps its session
  and PR, takes a scheduler slot, and its gate reopens and is judged afresh. A spent budget,
  `config`/`policy`/`blocked`, an unclassified failure and an unanswered or expired question set
  `attention` and park that task only; siblings keep running. `core/test/batch-recovery.test.ts`,
  `server/test-db/batch-dispatch.test.ts`.
- **Questions are never answered or extended by the board:** a pending one shows as `attention`
  with its id and the answer route; a run that dies holding one is not retried automatically.
  `server/src/db/batch-store-schedule.ts` (`syncQuestion`).
- **The time limit is a fence like cancel:** the pass that finds `deadline_at` passed stamps
  `expired_at` once, cancels work that never launched, stops moving work, and queues no recovery or
  advance behind it; manual retry answers `409 BATCH_EXPIRED`, while merges and acceptances that
  land are still recorded and reported. `server/test-db/batch-dispatch.test.ts`.
- **Limits of recovery:** repair triggers only on a run's own `failure_kind`; a PR that turns red or
  conflicts after a successful run is observed, not repaired. `server/src/db/batch-store-schedule.ts`
  (`recoverFailed`).
- **Cancel is a fence, then a settle.** `cancelled_at` commits first, so nothing launches, retries
  or advances behind it; moving tasks are stopped through the job store's stop, repeated by every
  later pass until nothing moves. `server/test-db/batch-dispatch.test.ts`.
- **A thread that backs a batch task is batch history:** `removeThread` and `reopen` refuse it
  (`BATCH_TASK_THREAD`); a retry is a new job of the same thread, never a new root.
  `server/test-db/batch-dispatch.test.ts`.
- **A missed callback cannot strand a batch:** `reconcileBatches` runs at boot and every
  `BATCH_RECONCILE_INTERVAL_MS`, and a held `waitFor` reconciles on every beat.
  `server/test/batch-reconciler.test.ts`.
- The attempt record carries the target branch always and the source revision when a `revisionOf`
  resolver is given to `createBatchStore`; the board wires the installation's branch read
  (`server/src/orgs.ts`), so a downstream task records a revision that holds the verified merges.
- **The web is a client of these routes, never a scheduler:** it polls the record and presses the
  same retry, accept and cancel the CLI does, so a batch created in either is operated in the
  other. `web/src/batch-model.ts`, `e2e/batches.spec.ts`.
- The routes are registered always and answer `503 BATCHES_UNAVAILABLE` for an org whose runtime
  has no batch store, the way the env and workflow routes do (`server/src/orgs.ts`).
