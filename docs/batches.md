# Batches

A batch is an ordered plan of stages of parallel tasks across one or more repository targets: a
draft an org member edits whole, validates, then starts. Start freezes the resolved plan; the
scheduler then runs one stage at a time, its tasks in parallel, as ordinary job threads. A task's
gate passes on a human-merged PR or a person's recorded acceptance. No driver or runner change.

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
| Routes (wait, retry, cancel, accept) | `server/src/routes/batches.ts`, `batch-handlers.ts` | `server/test/routes.batches.test.ts` |
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
  `reason` `multi_target`, `non_default_branch` or `automerge` (the board merges nothing yet).
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
- **Limits of the human gate:** the board never merges (automerge is refused at start); a merge
  after which more commits were pushed, a closed-unmerged PR and a webhook that never arrived are
  not detected; accept needs a human org member, not repository write access.
  `core/src/batch-plan.ts` (`batchExecutionCapability`), `server/src/db/batch-store-gates.ts`.
- **Cancel is a fence, then a settle.** `cancelled_at` commits first, so nothing launches, retries
  or advances behind it; moving tasks are stopped through the job store's stop, repeated by every
  later pass until nothing moves. `server/test-db/batch-dispatch.test.ts`.
- **A thread that backs a batch task is batch history:** `removeThread` and `reopen` refuse it
  (`BATCH_TASK_THREAD`); a retry is a new job of the same thread, never a new root.
  `server/test-db/batch-dispatch.test.ts`.
- **A missed callback cannot strand a batch:** `reconcileBatches` runs at boot and every
  `BATCH_RECONCILE_INTERVAL_MS`, and a held `waitFor` reconciles on every beat.
  `server/test/batch-reconciler.test.ts`.
- The attempt record carries the target branch always and the source revision only when a
  `revisionOf` resolver is given to `createBatchStore`; the board wires none yet.
- **The web is a client of these routes, never a scheduler:** it polls the record and presses the
  same retry, accept and cancel the CLI does, so a batch created in either is operated in the
  other. `web/src/batch-model.ts`, `e2e/batches.spec.ts`.
- The routes are registered always and answer `503 BATCHES_UNAVAILABLE` for an org whose runtime
  has no batch store, the way the env and workflow routes do (`server/src/orgs.ts`).
