# Job board

A job is a text command a worker runs as an agent prompt; the board leases jobs out and records
verdicts, and the driver is the only process that spawns anything. Graphs are
[workflows.md](workflows.md), the kubernetes executor [kubernetes.md](kubernetes.md), credentials
[auth.md](auth.md).

## Board

| Concern | Code | Test |
| --- | --- | --- |
| Routes, validation, refusal codes | `server/src/routes/jobs/jobs.ts`, `job-handlers-worker.ts`, `job-handlers-actions.ts`, `job-field-validation.ts`, `job-refusals.ts`, `job-limits.ts` | `server/test/routes.jobs.test.ts` |
| Schema | `server/migrations/006_jobs.sql` and later `0*_job_*.sql` | `server/test-db/job-store.test.ts` |
| `failure_cause` under a `gate`/`publish`/`helper` kind | `server/migrations/065_batch_recovery_evidence.sql`, `server/src/db/jobs/job-store-worker.ts`, `job-store-evidence.ts` | `server/test-db/job-store.test.ts` |
| Claim, lease, fencing, `claim_seq`, settle long-poll; interruption budget and lease expiry; settle receipts per lease token; execution provenance: one `job_execution` row per claim in the claim transaction, a retained session an inferred `inferred_at_claim` association, no FK to the job | `server/src/db/jobs/job-store-claim.ts`, `job-store-claim-row.ts`, `job-store.ts`, `server/src/db/jobs/job-store-actions.ts`, `server/migrations/071_job_interruptions.sql`, `server/src/db/jobs/job-store-receipts.ts`, `server/migrations/072_job_settle_receipts.sql`, `server/src/db/jobs/job-store-provenance.ts`, `server/migrations/085_job_execution.sql` | `server/test-db/job-store.test.ts`, `job-store.thread-claim.test.ts`, `job-store.settle.test.ts`, `server/test-db/job-store.interrupt.test.ts`, `server/test-db/job-store.receipts.test.ts`, `server/test-db/job-store.execution-provenance.test.ts` |
| Shared admission budgets (`ADMISSION_MAX_RUNNING{,_PER_ORG,_PER_REPO}`): slots held by running rows, handed-over rows offered first; cross-org claim order from rows (takeover, fewest running, oldest waiting) | `server/src/db/jobs/job-store-admission.ts`, `job-store-claim.ts`, `server/migrations/081_job_admission.sql`, `server/src/routes/jobs/job-context.ts` | `server/test-db/job-store.admission.test.ts`, `job-store.fairness.test.ts`, `server/test/config.admission.test.ts`, `routes.jobs.test.ts`, `scripts/test-jobs.sh` and `scripts/test-k8s.sh` (`capacity`) |
| Status transitions: the only `job.status` moves; a verdict lands `succeeded` or `failed`, a policy refusal rewrites it in the same transaction | `server/migrations/084_job_status_transitions.sql`, `server/src/db/jobs/job-store-worker.ts`, `job-store-evidence.ts` | `server/test-db/job-store.transitions.test.ts` |
| Staged conclusion (`POST /conclusion`) | `server/src/db/jobs/job-store-conclusions.ts`, `job-store-staged.ts`, `server/migrations/076_job_conclusions.sql`, `073_job_claim_deferral.sql` | `server/test-db/job-store.conclusions.test.ts`, `job-store.claim-prep.test.ts`, `server/test/routes.job-conclusion.test.ts` |
| Phase checkpoints: setup, gates, post, publish outcomes an adopter resumes from (`POST /:id/phase-checkpoint`, `/phase-checkpoints`) | `server/src/db/jobs/job-store-phase-checkpoints.ts`, `server/migrations/080_job_phase_checkpoints.sql`, `server/migrations/083_phase_checkpoint_setup.sql`, `driver/src/loop/loop-phase-checkpoints.ts`, `driver/src/board/board-phase-checkpoints.ts` | `server/test-db/job-store.phase-checkpoints.test.ts`, `driver/test/loop-phase-checkpoints.test.ts` |
| Follow-up, done, retry, command edit, sessionless recap | `server/src/db/jobs/job-store-actions.ts`, `follow-up-recap.ts` | `server/test-db/job-store.follow-ups.test.ts`, `job-store.retries.test.ts`, `job-store.command-edit.test.ts`, `server/test/follow-up-recap.test.ts` |
| Stop, remove, reopen, reclaim ownership, merged PR closing threads | `server/src/db/jobs/job-store-actions.ts`, `job-store-reclaims.ts`, `job-store-merge.ts`, `server/migrations/075_task_reclaim_ownership.sql` | `server/test-db/job-store.stop-remove.test.ts`, `job-store.merge-close.test.ts` |
| Task summary (`GET /api/tasks`); Attribution, wall clock, `setupMs`, publication | `server/src/db/task-summary.ts`, `server/src/routes/tasks.ts`, `server/src/db/jobs/job-store-reads.ts`, `job-store-rows.ts`, `web/src/format.ts` | `server/test/task-summary.test.ts`, `server/test/routes.tasks.test.ts`, `server/test-db/job-store.attribution.test.ts`, `job-store.wall-clock.test.ts`, `job-store.publication.test.ts` |
| Mutation idempotency (`Idempotency-Key`) | `server/src/routes/jobs/job-idempotency.ts`, `server/src/db/jobs/job-store-idempotency.ts` | `server/test-db/job-store.idempotency.test.ts`, `server/test-db/cli.scripting.test.ts` |
| `.bellows.yaml` grammar: gates, `environment`, `policy:`, `reviewers:`, services | `server/src/workspace/bellows.ts`, `bellows-services.ts`, `bellows-reviewers.ts`, `bellows-cache.ts` | `server/test/bellows.test.ts`, `bellows.plan.test.ts`, `bellows.policy.test.ts`, `bellows.reviewers.test.ts` |
| Execution plan at claim, read at the base branch tip (gates, services, `reviewerProfiles` names); Master prompt and turn context | `server/src/github/file-read.ts`, `server/src/workspace/bellows-plan.ts`, `server/migrations/018_job_gates.sql`, `server/src/db/master-prompt.ts` | `server/test/claim-plan.test.ts`, `server/test-db/job-store.gates.test.ts`, `server/test/master-prompt.test.ts` |
| Objective mode (no `workflow`) | `core/src/job-mode.ts`, `server/migrations/051_job_mode.sql` | `server/test-db/job-store.objective.test.ts` |
| Skill selection and `skillRefusal` | `core/src/skills.ts`, `server/src/skills.ts`, `server/migrations/055_job_skills.sql` | `core/test/skills.test.ts`, `server/test-db/job-store.skills.test.ts` |
| Evidence policy and the completion check | `server/src/db/evidence-policy.ts`, `job-store-evidence.ts`, `server/migrations/053_job_evidence.sql` | `server/test/evidence-policy.test.ts`, `server/test-db/job-store.evidence.test.ts` |
| Independent reviewer jobs (`review_of`): the row is created `running` and leased in the request under the caller's `claim_seq`, never queued; it has no reclaim of its own, its review root (`<task tree>.reviews/<root>`) lives on the caller's task volume and goes with it | `server/src/db/jobs/job-store-reviews.ts`, `review-prompt.ts`, `server/src/routes/jobs/job-handlers-reviews.ts`, `server/migrations/077_review_inband.sql` | `server/test-db/job-store.reviews.test.ts`, `server/test/review-prompt.test.ts` |
| Agent questions, capped per `claim_seq` | `server/src/db/jobs/job-store-questions.ts`, `server/src/routes/jobs/job-handlers-questions.ts` | `server/test-db/job-store.questions.test.ts` |
| Run artifacts: object store, chunk and manifest index ([persistence.md](persistence.md)) | `server/src/artifacts/artifact-store.ts`, `server/migrations/070_artifact_index.sql`, `server/src/routes/jobs/job-handlers-artifacts.ts` | `server/test-db/artifact-store.test.ts`, `server/test/routes.artifacts.test.ts`, `server/test-db/job-store.artifact-scope.test.ts` |

## Driver and runners

| Concern | Code | Test |
| --- | --- | --- |
| Claim loop, verdicts, reclaim, staged-then-completed teardown; attempt lifecycle owner (`loop-phase.ts` phase and first-wins ending, `end()` in `loop-conclusion.ts`) | `driver/src/loop/loop.ts`, `board.ts`, `board-verdict.ts`, `loop-conclusion.ts`, `loop-phase.ts`, `reclaim-calls.ts`, `claim.ts`, `board-retry.ts`, `verdict-budget.ts` | `driver/test/loop/`, `loop-phase.test.ts`, `loop-conclusion.test.ts`, `board.test.ts`, `board-retry.test.ts`, `loop-containment.test.ts`, `loop-run.test.ts` |
| Stand-down fence, interruption vs failure (`settleEnd`), startup cause, drain handover | `driver/src/loop/loop-fence.ts`, `loop-run.ts`, `loop-attempt.ts`, `termination.ts`, `startup-cause.ts` | `driver/test/loop-fence.test.ts`, `loop-run.test.ts`, `loop-heartbeat-handover.test.ts`, `termination.test.ts`, `startup-cause.test.ts`, `loop-phase-faults.test.ts`, `loop-phase.test.ts` (a heartbeat request is bounded by one beat period) |
| Executor conformance tables | `driver/test/fixtures/termination-table.ts`, `fixtures/startup-table.ts` | `driver/test/docker/`, `k8s/` |
| Master prompt; turn-context hook; continuation framing | `driver/src/master-prompt.ts`, `runner-plan.ts`, `continuation.ts`, `docker/claude-executor/turn-context-hook.cjs` | `driver/test/master-prompt.test.ts`, `runner-plan.test.ts`, `continuation.test.ts`, `turn-context-hook.test.ts` |
| Docker runner; Kubernetes runner; Executor contract (every `Runner` member, both executors) | `driver/src/docker/docker-runner.ts`, `docker.ts`, `runner.ts`, `config.ts`, `driver/src/k8s/`, `driver/src/runner.ts`, `docker-runner.ts`, `k8s-runner.ts` | `driver/test/docker/`, `config.test.ts`, `driver/test/k8s/`, `k8s-admission.test.ts`, `k8s-transport.test.ts`, `driver/test/runner-contract.test.ts` |
| Gates and `environment.setup` as supervised steps | `driver/src/gates.ts`, `loop-gates.ts`, `docker-gate.ts`, `k8s-gate.ts`, `scripts/gate-loop.sh` | `driver/test/gates.test.ts`, `gates-limits.test.ts`, `gates-ownership.test.ts`, `scripts-gate-loop.test.ts`, `setup-budget.test.ts` |
| Task supervisor, its mailboxes and its holder binding (newer claim only) | `driver/src/scripts/supervisor.cjs`, `supervisor-contract.ts`, `supervisor-plan.ts`, `docker-group.ts`, `docker-mailbox.ts`, `k8s-podspec.ts`, `k8s-binding.ts`, `scripts/binding-write.sh` | `driver/test/supervisor.test.ts`, `docker-group.test.ts`, `scripts-binding-write.test.ts`, `k8s/`, `k8s-admission.test.ts` |
| An agent container the driver read over with no `agent.exit` is a lost agent in seconds, not the start or heartbeat window: docker's `agentContainerEnded` (the daemon's `exited`/`dead`), kubernetes' terminated `agent` state in the poll; both say `StepSink.agentEnded`, the control poll carries `agentEnded`, and an unreadable state says nothing | `driver/src/docker/docker-runner-support.ts`, `k8s-poll.ts`, `step-control.ts`, `control-channel.ts`, `scripts/supervisor.cjs` (`watchAgent`) | `driver/test/supervisor.test.ts`, `step-control.test.ts`, `docker/`, `k8s/` |
| Supervised steps, group lifecycle (`settle`, `release`, `attach`, first contact) | `driver/src/supervised-steps.ts`, `step-control.ts`, `k8s-group.ts`, `docker-group.ts`, `group-watch.ts`, `docker-teardown.ts`, `k8s-teardown.ts`, `poll.ts` | `driver/test/supervised-steps.test.ts`, `poll.test.ts`, `step-control.test.ts`, `k8s-group.test.ts`, `group-watch.test.ts`, `docker/helper-and-hardening.test.ts` |
| Run control (`GET /control`, agent mailbox helper, step-boundary hook) | `driver/src/control-channel.ts`, `docker/claude-executor/ctl-agent.cjs`, `stop-hook.cjs`, `docker/opencode-executor/stop-plugin/index.js` | `driver/test/run-control.test.ts`, `driver/test/gates.test.ts` |
| Failure kind and cause, `FACTORY_BLOCKED:`, timeout note | `driver/src/loop/loop-ledger.ts`, `loop-verdict.ts`, `gate-cause.ts`, `exec-codes.ts`, `timeout-note.ts` | `driver/test/loop-ledger.test.ts`, `gate-cause.test.ts`, `publish-cause.test.ts`, `timeout-note.test.ts` |
| Services: start, probe, restart, `infraLoss` | `driver/src/services.ts`, `loop-services.ts`, `service-restart.ts`, `k8s-services.ts` | `driver/test/services.test.ts` |
| Task volume and checkout (clone, retry rebase, restore), publish, PR identity, `baseBranch` | `driver/src/publish/publish.ts`, `publish-pr.ts`, `publish-base.ts`, `task-volume.ts`, `docker-task-volume.ts`, `driver/src/scripts/task-checkout.cjs` | `driver/test/publish-checkout.test.ts`, `scripts-task-checkout.test.ts`, `docker-task-volume.test.ts`, `base-branch-executors.test.ts` |
| Publication ledger, reconcile, agent draft publish (`POST /publish`) | `driver/src/publish/publish-reconcile.ts`, `operation-ledger.ts`, `driver/src/scripts/operation-ledger.cjs`, `publish-control.ts`, `loop-publish.ts` | `driver/test/publish-reconcile.test.ts`, `scripts-operation-ledger.test.ts`, `publish-control.test.ts` |
| Agent-opened PR, git guard | `docker/claude-executor/git-guard.cjs`, `docker/opencode-executor/opencode-home/opencode.json` | `driver/test/executor-images.test.ts` |
| Evidence policy, driver side (tree fingerprint, `stale`) | `driver/src/evidence-policy.ts`, `publish-stale.ts`, `scripts/git-probe.cjs` | `driver/test/evidence-policy.test.ts`, `publish-hooks.test.ts`, `publish-stale.test.ts`, `tree-fingerprint.test.ts` |
| Reviewer invocation (`POST /review`, snapshot ref): runs in the caller's pod or group as `review` steps (`superviseReview`), never a Job; the `reviewer` container on docker, sidecar on kubernetes | `driver/src/review/review-control.ts`, `loop-review.ts`, `review-step.ts`, `review-snapshot.ts`, `docker-group.ts` (`reviewerCreateArgs`) | `driver/test/review-control.test.ts`, `loop-review.test.ts`, `review-step.test.ts`, `review-snapshot.test.ts`, `docker-group.test.ts` |
| Question routes and relay; paused runtime budget | `driver/src/question-control.ts`, `loop-questions.ts`, `run-deadline.ts` | `driver/test/gates.test.ts`, `run-deadline.test.ts` |
| `AskUserQuestion` bridge; prose-question `Stop` hook | `docker/claude-executor/claude-bridge.cjs`, `web/src/task-outcome.ts` | `driver/test/claude-bridge.test.ts`, `web/test/task-derivations.test.ts` |
| Block-helper steps and receipts | `driver/src/helpers.ts`, `helper-receipts.ts`, `loop-helpers.ts` | `driver/test/helpers.test.ts`, `helper-receipts.test.ts` |
| GitHub review collect and reply | `driver/src/review/review.ts`, `review-helpers.ts`, `loop-github.ts`, `driver/src/scripts/review-*.cjs`, `container-scripts.ts` | `driver/test/scripts.test.ts`, `review-collect-script.test.ts`, `review-reply-script.test.ts`, `review-helpers.test.ts` |
| Session id, close-time agent turns, `ownSession` resume | `driver/src/close-read.ts`, `docker-close-read.ts`, `runner-plan.ts`, `driver/src/scripts/claude-turns.cjs` | `driver/test/close-read.test.ts`, `scripts-claude-turns.test.ts` |
| opencode session export and branch reporter | `driver/src/scripts/opencode-readout.cjs`, `docker/opencode-executor/branch-reporter.cjs`, `server/src/routes/ingest.ts` | `driver/test/scripts-opencode-export.test.ts`, `branch-reporter.test.ts`, `server/test/routes.ingest.test.ts` |
| Artifact upload and Claude transcript export | `driver/src/artifact-upload.ts`, `artifact-calls.ts`, `loop-export.ts`, `export-control.ts`, `transcript-export.ts`, `driver/src/scripts/claude-export.cjs`; an in-band review exports once, as a step under a token bound to the review row | `driver/test/artifact-upload.test.ts`, `loop-export.test.ts`, `export-control.test.ts`, `scripts-claude-export.test.ts`, `review-step.test.ts` |
| Attempt checkpoint at finalize: a header line, a git bundle of the whole tree against every remote-tracking ref and the OpenCode snapshot, on the `checkpoint` stream; above 256 MiB no bytes, `truncated` (`checkpoint_cap`); both executors build the supervisor's env from one function | `driver/src/scripts/checkpoint.cjs`, `scripts/supervisor.cjs` (`checkpointStage`), `supervisor-plan.ts`, `export-control.ts` (`/checkpoint/*`), `loop-export.ts` | `driver/test/scripts-checkpoint.test.ts`, `supervisor-checkpoint.test.ts`, `supervisor-plan-checkpoint.test.ts`, `checkpoint-control.test.ts`, `loop-checkpoint.test.ts` |
| Restore, board half: the thread's pointer and raw Claude transcripts read under the live lease; failure kind `checkpoint_unrestorable` (a thread with no volume and no restorable checkpoint fails its follow-up) | `server/src/routes/jobs/job-handlers-restore.ts`, `db/jobs/job-store-reads.ts` (`restoreScopeOf`), `job-field-validation.ts`, `web/src/task-outcome.ts` | `server/test/routes.restore.test.ts`, `server/test-db/job-store.restore-scope.test.ts` |
| Orphan reaper, its task-volume sweep (`volumeDecision`, thread facts on the root's `leasesOf` row), runner adoption and live takeover (`adopt-skeleton.ts`, `loop-adopt.ts`), kill ledger (`kill-ledger.ts`), kill reasons; destructive reads typed as a value, a confirmed absence or nothing proven (`Read`) | `driver/src/reaper.ts`, `docker-reaper.ts`, `k8s-reaper.ts`, `board.ts`, `server/src/db/jobs/job-store-reads.ts` (`leasesOf`), `adopt-skeleton.ts`, `kill-ledger.ts`, `k8s-adopt.ts`, `runner.ts`, `k8s-poll.ts`, `k8s-shapes.ts`, `docker-runner-support.ts`, `docker-group.ts`, `docker-close-read.ts`, `supervisor-contract.ts` | `driver/test/reaper.test.ts`, `adopt-skeleton.test.ts`, `kill-ledger.test.ts`, `docker-reaper.test.ts`, `k8s-reaper.test.ts`, `board.test.ts`, `server/test-db/job-store.thread-facts.test.ts`, `k8s-read-faults.test.ts`, `docker-read-faults.test.ts`, `loop-adopt.test.ts`, `k8s-adopt.test.ts`, `supervisor.test.ts` |
| Runner skills: `pr-land` (hinted by the master prompt), `backend-fix` | `docker/skills/pr-land/SKILL.md`, `docker/skills/backend-fix/SKILL.md` | `driver/test/pr-land-status-script.test.ts`, `executor-images.test.ts` |
| Board + driver end to end | `scripts/test-jobs.sh` | `server/test/test-jobs.harness.test.ts`, `driver/test/compose.test.ts` |

## CLI (`bellows …`)

| Concern | Code | Test |
| --- | --- | --- |
| Entry, dispatch, board client, config | `cli/src/index.ts`, `run.ts`, `board.ts`, `config.ts`, `http.ts` | `cli/test/commands.test.ts`, `board-client.test.ts`, `config.test.ts`, `server/test-db/cli.scripting.test.ts` |
| Outcomes, exit codes, `--json` envelope; Transport: deadlines, retries of reads and keyed writes only | `cli/src/outcome.ts`, `render.ts`, `cli/src/transport.ts` | `cli/test/commands.test.ts`, `cli/test/board-client.test.ts` |
| Prompt input, `task list`, discovery | `cli/src/input.ts`, `tasks.ts`, `discovery.ts` | `cli/test/input.test.ts`, `tasks.test.ts`, `discovery.test.ts` |
| Diagnostics (`auth status`, `job preflight`, help, `--version`) | `cli/src/diagnose.ts`, `diagnostics.ts`, `selection.ts`, `usage.ts`, `version.ts` | `cli/test/diagnostics.test.ts` |
| `job activity`, `streams`, `read`; `retry`, `edit`, `reopen`; `questions`, `answer`; `--idempotency-key` | `cli/src/artifacts.ts`, `board.ts`, `run.ts` | `cli/test/artifacts.test.ts`, `retry-edit.test.ts`, `questions.test.ts`, `idempotency.test.ts` |
| `batch` subcommands ([batches.md](batches.md)) | `cli/src/batch.ts`, `batch-commands.ts`, `batch-render.ts` | `cli/test/batch.test.ts` |

## Invariants

- **A declared `.bellows.yaml` service runs hardened, which breaks stock images that expect root.**
  A stock postgres chowns its data directory as root at first boot and crash-loops; `user: "uid:gid"` is the
  fix, and there is no opt-out: the board refuses `unhardened` at parse. `server/src/workspace/bellows-services.ts`,
  `server/test/bellows.plan.test.ts`, [security.md](security.md).
- **A run reports agent turns**: the close-time agent-turn read counts the executor's own transcript; a job turn
  is in [docs/metrics.md](metrics.md). Null is the contract for unmeasured. `core/test/docs.terminology.test.ts`.
- **A `409` from heartbeat means the container must be killed**; `cancelRequested` during the agent's run
  drains to the next step boundary instead. `driver/test/loop/`.
- **Every resource an attempt creates is scoped by its lease token**, so no sweep touches a sibling
  attempt — `driver/src/labels.ts`, `driver/test/docker/`. On docker each also carries the board's
  `factory.board`, the only objects that board's reaper scans — `driver/test/docker-reaper-boards.test.ts`.
- **A supervisor lost under a publish is an interruption, never `publishFailed`** (`stepLost` is rethrown by `publishCheckout` and `publishBranch`, ended in `loop-post-run.ts`) — `driver/test/publish-reconcile.test.ts`, `loop/`.
- **The publish decision is made in `driver/src/loop/loop-verdict.ts` and `loop-publish.ts` only** —
  `driver/test/docker/`, `k8s/`.
- **A decided verdict is staged, then completed, and only then is the attempt torn down**; it is retried on
  5xx and never rewritten — `driver/test/loop/`, `board-retry.test.ts`.
- **A null `masterPrompt` on the wire is refused before setup**, and the render never reads command,
  output or env values — `driver/test/master-prompt.test.ts`, `server/test/master-prompt.test.ts`.
- **The executor label resolves at claim in the task's stamped scope**; a missing profile fails the
  task rather than defaulting — `server/test-db/job-store.executor-scope.test.ts`.

## Operational facts

- The CLI needs `FACTORY_URL` or `url` in `~/.bellows/settings.json` / `--config <path>` (no default;
  `cli/src/config.ts`); run it as `npm run dev -w cli -- job list`. Exit `0` means the verdict `succeeded`,
  never that a PR is ready (`cli/src/outcome.ts`).

## Stated limits

- Ad-hoc gate runs are not evidence; under `policy: gates: required` a draft publication is refused.
- A reviewer profile grants connections and a budget, not a tool allowlist; snapshot refs
  (`refs/factory/review/*`) are never deleted.
- Admission budgets count board leases, not pods; a rollout runs each replica's values. Org fairness is eventual:
  polls reading the same demand at once may serve one org; the next free slot goes to the other. A poll whose claim the global budget refused admits nothing from later boards (takeovers aside). Reclaims rotate.
- No priority; no per-job authorization ([repos.md](repos.md)); no service volumes, health checks,
  `depends_on` or restart policies in `.bellows.yaml`.
- No abort for an in-flight publish; the next lease holder reads the ledger and the remote first. A custom
  `RUNNER_IMAGE` missing a skill's declared tool is not detected.
- Only the tail-kept log and the opencode transcript upload whole-or-cut (`ARTIFACT_LIMIT`); no sweeper
  deletes a removed task's objects (`driver/src/runner.ts`, `k8s-transport.ts`).
