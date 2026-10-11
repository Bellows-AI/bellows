# Batches

A batch is an ordered plan of stages of parallel tasks across one or more repository targets: a
draft an org member edits whole, validates, then starts. Start freezes the resolved plan and queues
no work — dispatch, PR binding and the retry/cancel/accept behavior arrive with their own issues,
and their routes answer `409 BATCH_UNSUPPORTED` until then. No driver or runner change.

| Concern | Code | Test |
| --- | --- | --- |
| Plan contract v1: types, bounds, `validateBatchPlan`, `resolveBatchPlan`, `batchExecutionCapability` | `core/src/batch-plan.ts` | `core/test/batch-plan.test.ts` |
| Error codes (`BAD_BATCH`, `BATCH_STALE`, `BATCH_STARTED`, `BATCH_UNSUPPORTED`, `BATCH_NO_DEFAULT_BRANCH`, `BATCHES_UNAVAILABLE`) | `core/src/error-codes.ts` | `core/test/error-codes.test.ts` |
| Schema: `batch`, `batch_target`, `batch_stage`, `batch_task`, `batch_idempotency`, the immutability triggers | `server/migrations/059_batches.sql` | `server/test-db/batch-store.test.ts` |
| Store bound to `orgId`: create, get, list, replace, start | `server/src/db/batch-store.ts`, `batch-store-rows.ts`, `batch-store-types.ts` | `server/test-db/batch-store.test.ts` |
| Idempotency records for create and start | `server/src/db/batch-store-idempotency.ts` | `server/test-db/batch-store.test.ts` |
| Routes and the lifecycle stubs | `server/src/routes/batches.ts`, `batch-handlers.ts` | `server/test/routes.batches.test.ts` |
| Launch checks shared by `validate` and `start` | `server/src/routes/batch-launch.ts` | `server/test/routes.batches.test.ts` |
| Request envelope, org context, refusals | `server/src/routes/batch-http.ts` | `server/test/routes.batches.test.ts` |
| Auth wall: human credentials only | `server/src/auth/plugin.ts` | `server/test/auth.enforcement.test.ts` |
| CLI client: `factory batch …`, draft round-trip, wait exit codes | `cli/src/batch.ts`, `batch-commands.ts`, `batch-render.ts` | `cli/test/batch.test.ts` |
| In-memory store double for the offline route tests | `server/test/helpers-batch-store.ts` | `server/test/routes.batches.test.ts` |

## Invariants

- **Stage order is the only dependency model.** An unknown field (`dependsOn` above all) is
  refused at every level of the plan, never ignored. `core/test/batch-plan.test.ts`.
- **Structural validity is independent of execution capability.** A two-repository plan is valid,
  persists and round-trips; only `start` and `validate` refuse it, with `409 BATCH_UNSUPPORTED` and
  `reason` `multi_target` or `non_default_branch`. `server/test/routes.batches.test.ts`.
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
- The routes are registered always and answer `503 BATCHES_UNAVAILABLE` for an org whose runtime
  has no batch store, the way the env and workflow routes do (`server/src/orgs.ts`).
