# Batches

A batch is an ordered plan of stages of parallel tasks across one or more repository targets: a
draft an org member edits whole, validates, then starts; start freezes the resolved plan and the
scheduler runs one stage at a time as ordinary job threads.

| Concern | Code | Test |
| --- | --- | --- |
| Plan contract v1: types, bounds, validate, resolve, execution capability; error codes (`BATCH_*`) | `core/src/batch-plan.ts`, `core/src/error-codes.ts` | `core/test/batch-plan.test.ts`, `core/test/error-codes.test.ts` |
| Schema, immutability triggers, `executor_scope`, runtime tables and attempts | `server/migrations/059_batches.sql`, `066_batch_executor_scope.sql`, `060_batch_runtime.sql`, `068_batch_task_closed.sql` | `server/test-db/batch-store.test.ts`, `server/test-db/batch-dispatch.test.ts` |
| Store bound to `orgId`; read `status` (`lifecycleOf`); idempotency | `server/src/db/batches/batch-store.ts`, `batch-store-rows.ts`, `batch-store-types.ts`, `batch-store-idempotency.ts` | `server/test-db/batch-store.test.ts` |
| Pure readiness, capacity, advancement, human gate (`judgeTaskGate`) | `core/src/batch-schedule.ts` | `core/test/batch-schedule.test.ts` |
| Scheduling transactions: reconcile, retry, cancel, accept, close | `server/src/db/batches/batch-store-schedule.ts`, `batch-store-close.ts`, `batch-store-threads.ts`, `batch-store-gates.ts`, `server/migrations/061_batch_acceptance.sql`; periodic and startup reconcile in `server/src/batch-reconciler.ts` | `server/test-db/batch-dispatch.test.ts`, `server/test/batch-reconciler.test.ts` |
| Thread guards: remove/reopen refuse, `done --force` | `server/src/db/jobs/job-store-actions.ts`, `server/src/routes/jobs/job-handlers-actions.ts`, `cli/src/run.ts` | `server/test/routes.jobs.test.ts`, `cli/test/commands.test.ts` |
| Recovery: classification, backoff, repair command, attention | `core/src/batch-recovery.ts`, `server/src/db/batches/batch-store-repair.ts`, `driver/src/loop/loop-ledger.ts`, `driver/src/gate-cause.ts`, `server/migrations/062_batch_recovery.sql` | `core/test/batch-recovery.test.ts`, `driver/test/loop-ledger.test.ts`, `driver/test/gate-cause.test.ts` |
| PR observation: assessment, fingerprint, rows, observer loop (batch PRs only; other PRs belong to the follower in [workflows.md](workflows.md)) | `core/src/batch-observation.ts`, `server/src/github/pr-read.ts`, `server/src/db/batches/batch-store-observation.ts`, `batch-store-observed.ts`, `server/src/batch-pr-observer.ts`, `server/migrations/063_batch_pr_observation.sql` | `core/test/batch-observation.test.ts`, `server/test/github.pr-read.test.ts`, `server/test-db/batch-pr-observation.test.ts`, `server/test-db/pr-follow.test.ts` |
| Automerge: decision, intents, slot, stage verification, merger loop | `core/src/batch-merge.ts`, `server/src/db/batches/batch-store-merge.ts`, `server/src/batch-merger.ts`, `server/src/github/pr-merge.ts`, `server/migrations/064_batch_merge.sql` | `core/test/batch-merge.test.ts`, `server/test-db/batch-merge.test.ts`, `server/test/github.pr-merge.test.ts` |
| Morning report, built from rows on every read; membership and token usage in ONE repeatable-read snapshot | `server/src/db/batches/batch-store-report.ts`, `core/src/usage-reduce.ts` | `server/test-db/batch-dispatch.test.ts`, `core/test/usage-reduce.test.ts` |
| Standing: the board's verdict (`standing` on every batch read; unread report -> `inconclusive`), which the CLI wait prints and never recomputes | `core/src/batch-standing.ts`, `server/src/routes/batches/batch-http.ts` (`withStanding`), `server/src/db/batches/batch-store-report.ts` (`readSnapshot`: record + report in one repeatable-read transaction) | `core/test/batch-standing.test.ts`, `server/test-db/batch-store.test.ts`, `server/test/routes.batches.standing.test.ts`, `cli/test/batch.test.ts` |
| Routes, launch checks, request envelope; auth wall (human credentials only) | `server/src/routes/batches/batches.ts`, `batch-handlers.ts`, `batch-launch.ts`, `batch-http.ts`, `server/src/auth/plugin.ts` | `server/test/routes.batches.test.ts` (with the in-memory double `server/test/helpers-batch-store.ts`), `server/test/auth.enforcement.test.ts` |
| CLI client (`bellows batch …`, wait exit codes) and local-session skill | `cli/src/batch.ts`, `batch-commands.ts`, `batch-render.ts`, `.claude/skills/batch-control/` | `cli/test/batch.test.ts`, `core/test/skills.batch-control.test.ts` |
| Web: list, composer, monitor ([design-system/batches.md](design-system/batches.md)) | `web/src/pages/Batch*Page.tsx`, `web/src/panels/Batch*.tsx`, `web/src/api/useBatches.ts`, `web/src/batch-model.ts` | `web/test/batch-model.test.ts`, `web/test/batch-detail.dom.test.tsx`, `e2e/batches.spec.ts` |

## Invariants

- **Stage order is the only dependency model**; an unknown field (`dependsOn` above all) is refused at every
  level of the plan. `core/test/batch-plan.test.ts`.
- **Only `start` and `validate` refuse an unsupported plan** (`409 BATCH_UNSUPPORTED`); launch checks run in one
  order for both and write nothing. `server/src/routes/batches/batch-launch.ts`, `server/test/routes.batches.test.ts`.
- **A draft write and the freeze race on `(org_id, id, version, status = 'draft')`**; exactly one wins, and the
  triggers refuse later writes to what freeze resolved. `server/test-db/batch-store.test.ts`.
- **Human credentials only**: no batch path is a worker route or on the org-token allowlist. `server/test/auth.enforcement.test.ts`.
- **Every scheduling write runs under the batch row's `for update` lock, each decision unique by
  `batch_decision.key`.** `server/test-db/batch-dispatch.test.ts`.
- **A task is accepted only when its run succeeded AND its gate passed**; a gate passes only with a
  `batch_acceptance` row, judged from durable rows. `core/test/batch-schedule.test.ts`.
- **Automerge asks, GitHub decides**: the intent is bound to the observed head and re-read before the send; one
  unresolved merge per repository and target (`batch_merge_slot_idx`); a stage advances only on a passed combined
  verification. `core/test/batch-merge.test.ts`, `server/test-db/batch-merge.test.ts`.
- **A task runs on its target's branch on both executors** via the claim's `baseBranch`.
  `server/src/db/jobs/job-store-claim.ts`, `driver/test/base-branch-executors.test.ts`; a target branch must pass
  `isBranchName`, `core/test/batch-plan.test.ts`.
- **A task's PR is observed from GitHub, never inferred from `failure_kind`**; webhooks only mark rows stale.
  `server/test/webhook.batch-observation.test.ts`.
- **Recovery budgets freeze at start and count durable `batch_attempt` rows**; a spent budget or unclassified
  failure parks that task only. `core/test/batch-recovery.test.ts`.
- **Cancel and the time limit are fences**: `cancelled_at` / `expired_at` commit first, nothing launches, retries
  or advances behind them. `server/test-db/batch-dispatch.test.ts`.
- **A thread that backs a batch task is batch history**: `removeThread` and `reopen` refuse it
  (`BATCH_TASK_THREAD`). `server/test-db/batch-dispatch.test.ts`.
- **A missed callback cannot strand a batch**: `reconcileBatches` runs at boot and every
  `BATCH_RECONCILE_INTERVAL_MS`. `server/test/batch-reconciler.test.ts`.
- An org with no batch store answers `503 BATCHES_UNAVAILABLE` (`server/src/orgs.ts`).
- **Batch usage reads only `batch_task.root_job_id`**; a live batch is provisional. `cli/test/batch.test.ts`.
- **The web is a client of these routes, never a scheduler**; the board never answers a question (a pending one
  shows as `attention`). `web/test/batch-detail.dom.test.tsx`, `server/src/db/batches/batch-store-schedule.ts`.

## Stated limits

- A merge followed by more pushed commits is not detected; accept needs an org member, not repo write access.
- Merge queues are not proven (405 parks the task), the method is `squash`, a repo with no checks never verifies.
