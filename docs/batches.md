# Batches

A batch is an ordered plan of stages of parallel tasks across one or more repository targets: a
draft an org member edits whole, validates, then starts; start freezes the resolved plan and the
scheduler runs one stage at a time as ordinary job threads.

| Concern | Code | Test |
| --- | --- | --- |
| Plan contract v1: types, bounds, validate, resolve, execution capability | `core/src/batch-plan.ts` | `core/test/batch-plan.test.ts` |
| Error codes (`BATCH_*`, `BATCHES_UNAVAILABLE`) | `core/src/error-codes.ts` | `core/test/error-codes.test.ts` |
| Schema, immutability triggers, `executor_scope` | `server/migrations/059_batches.sql`, `066_batch_executor_scope.sql` | `server/test-db/batch-store.test.ts` |
| Store bound to `orgId`; read `status` (`lifecycleOf`); idempotency | `server/src/db/batches/batch-store.ts`, `batch-store-rows.ts`, `batch-store-types.ts`, `batch-store-idempotency.ts` | `server/test-db/batch-store.test.ts` |
| Runtime tables and attempts | `server/migrations/060_batch_runtime.sql`, `068_batch_task_closed.sql` | `server/test-db/batch-dispatch.test.ts` |
| Pure readiness, capacity, advancement, human gate (`judgeTaskGate`) | `core/src/batch-schedule.ts` | `core/test/batch-schedule.test.ts` |
| Scheduling transactions: reconcile, retry, cancel, accept, close | `server/src/db/batches/batch-store-schedule.ts`, `batch-store-close.ts`, `batch-store-threads.ts`, `batch-store-gates.ts`, `server/migrations/061_batch_acceptance.sql` | `server/test-db/batch-dispatch.test.ts` |
| Periodic and startup reconcile | `server/src/batch-reconciler.ts`, `server/src/orgs.ts` | `server/test/batch-reconciler.test.ts` |
| Thread guards: remove/reopen refuse, `done --force` | `server/src/db/jobs/job-store-actions.ts`, `server/src/routes/jobs/job-handlers-actions.ts`, `cli/src/run.ts` | `server/test/routes.jobs.test.ts`, `cli/test/commands.test.ts` |
| Recovery: classification, backoff, repair command, attention | `core/src/batch-recovery.ts`, `server/src/db/batches/batch-store-repair.ts`, `driver/src/loop/loop-ledger.ts`, `driver/src/gate-cause.ts`, `server/migrations/062_batch_recovery.sql` | `core/test/batch-recovery.test.ts`, `driver/test/loop-ledger.test.ts`, `driver/test/gate-cause.test.ts` |
| PR observation: assessment, fingerprint, rows, observer loop | `core/src/batch-observation.ts`, `server/src/github/pr-read.ts`, `server/src/db/batches/batch-store-observation.ts`, `batch-store-observed.ts`, `server/src/batch-pr-observer.ts`, `server/migrations/063_batch_pr_observation.sql` | `core/test/batch-observation.test.ts`, `server/test/github.pr-read.test.ts`, `server/test-db/batch-pr-observation.test.ts` |
| Batch PRs only; every other followed PR is read by the PR follower ([workflows.md](workflows.md)) | `server/src/batch-pr-observer.ts` (`readFacts`, `createReadPause` shared) | `server/test-db/pr-follow.test.ts` |
| Automerge: decision, intents, slot, stage verification, merger loop | `core/src/batch-merge.ts`, `server/src/db/batches/batch-store-merge.ts`, `server/src/batch-merger.ts`, `server/src/github/pr-merge.ts`, `server/migrations/064_batch_merge.sql` | `core/test/batch-merge.test.ts`, `server/test-db/batch-merge.test.ts`, `server/test/github.pr-merge.test.ts` |
| Morning report, built from rows on every read | `server/src/db/batches/batch-store-report.ts` | `server/test-db/batch-dispatch.test.ts` |
| Routes, launch checks, request envelope | `server/src/routes/batches/batches.ts`, `batch-handlers.ts`, `batch-launch.ts`, `batch-http.ts` | `server/test/routes.batches.test.ts` |
| Auth wall: human credentials only | `server/src/auth/plugin.ts` | `server/test/auth.enforcement.test.ts` |
| CLI client (`bellows batch …`, wait exit codes) | `cli/src/batch.ts`, `batch-commands.ts`, `batch-render.ts` | `cli/test/batch.test.ts` |
| Local-session skill | `.claude/skills/batch-control/` | `core/test/skills.batch-control.test.ts` |
| Web: list, composer, monitor ([design-system/batches.md](design-system/batches.md)) | `web/src/pages/Batch*Page.tsx`, `web/src/panels/Batch*.tsx`, `web/src/api/useBatches.ts`, `web/src/batch-model.ts` | `web/test/batch-model.test.ts`, `web/test/batch-detail.dom.test.tsx`, `e2e/batches.spec.ts` |
| In-memory store double for offline route tests | `server/test/helpers-batch-store.ts` | `server/test/routes.batches.test.ts` |

## Invariants

- **Stage order is the only dependency model**; an unknown field (`dependsOn` above all) is refused at
  every level of the plan. `core/test/batch-plan.test.ts`.
- **Structural validity is independent of execution capability**: only `start` and `validate` refuse an
  unsupported plan, `409 BATCH_UNSUPPORTED`. `server/test/routes.batches.test.ts`.
- **A draft write and the freeze race on `(org_id, id, version, status = 'draft')`**; exactly one wins.
  Freeze resolves branch, target, policy and executor scope in place and the triggers refuse later
  writes to them. `server/migrations/059_batches.sql`, `server/test-db/batch-store.test.ts`.
- **Launch checks run in one order for `validate` and `start`, and write nothing.**
  `server/src/routes/batches/batch-launch.ts`, `server/test/routes.batches.test.ts`.
- **Human credentials only**: no batch path is a worker route or on the organization-token allowlist.
  `server/test/auth.enforcement.test.ts`.
- **Every scheduling write runs under the batch row's `for update` lock and each decision is unique by
  `batch_decision.key`**, so duplicates and restarts launch and advance once.
  `server/test-db/batch-dispatch.test.ts`.
- **A task is accepted only when its run succeeded AND its gate passed**; a gate passes only with a
  `batch_acceptance` row (`pr_merged` or `accepted`), judged from durable rows on every pass. A run's
  verdict never satisfies the gate. `core/test/batch-schedule.test.ts`, `server/test-db/batch-dispatch.test.ts`.
- **Automerge asks, GitHub decides**: the intent is written under the batch lock, bound to the observed
  head and re-read before the send; one unresolved merge per repository and target
  (`batch_merge_slot_idx`). `core/test/batch-merge.test.ts`, `server/test-db/batch-merge.test.ts`.
- **An automerge stage advances only on a passed combined verification.**
  `server/test-db/batch-merge.test.ts`.
- **A task runs on its target's branch on both executors** via the claim's `baseBranch`.
  `server/src/db/jobs/job-store-claim.ts`, `driver/test/base-branch-executors.test.ts`.
- **A task's PR is observed from GitHub, never inferred from `failure_kind`**; webhooks only mark rows
  stale. `core/test/batch-observation.test.ts`, `server/test/webhook.batch-observation.test.ts`.
- **Recovery budgets freeze at start and are counted from durable `batch_attempt` rows**; a spent budget
  or unclassified failure parks that task only. `core/test/batch-recovery.test.ts`.
- **Questions are never answered by the board**; a pending one shows as `attention`.
  `server/src/db/batches/batch-store-schedule.ts`.
- **Cancel and the time limit are fences**: `cancelled_at` / `expired_at` commit first, nothing launches,
  retries or advances behind them, and merges that land are still recorded.
  `server/test-db/batch-dispatch.test.ts`.
- **A thread that backs a batch task is batch history**: `removeThread` and `reopen` refuse it
  (`BATCH_TASK_THREAD`). `server/test-db/batch-dispatch.test.ts`.
- **A missed callback cannot strand a batch**: `reconcileBatches` runs at boot and every
  `BATCH_RECONCILE_INTERVAL_MS`. `server/test/batch-reconciler.test.ts`.
- **The web is a client of these routes, never a scheduler.** `web/test/batch-detail.dom.test.tsx`.
- Routes answer `503 BATCHES_UNAVAILABLE` for an org with no batch store (`server/src/orgs.ts`).

## Stated limits

- A merge followed by more pushed commits is not detected; accept needs an org member, not repo write access.
- Merge queues are not proven (a 405 parks the task), the method is `squash`, and a repository with no
  checks never verifies (`core/src/batch-merge.ts`).
