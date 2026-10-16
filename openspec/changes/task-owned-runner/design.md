# Design: task-owned runner

## Status and architecture

Proposed implementation contract; resource sizes and retention durations remain deployment policy.
One pod belongs to one claim sequence. Sequential attempts may recover the task volume only
after the previous writer is fenced. A supervisor owns the state machine:
prepare -> setup -> execute -> verify -> publish -> finalize -> report.
Ad-hoc commands, questions and reviewer sessions are supervised branches of this lifecycle.
Failure and cancellation enter finalization without implying successful verification/publication.

The driver creates the complete pod, monitors leases and reaps resources. The supervisor does
not need Kubernetes API access. Agent exit does not terminate the supervisor or uploader.
Declared gate/service/helper images become predeclared pod containers with scoped mounts and
authenticated local control. Images are pinned in the execution plan before scheduling.
Dynamic requests outside that plan fail explicitly before side effects; no hidden aux-Job fallback.
Unknown image requirements must be resolved during planning, not discovered after agent launch.

## Storage ownership

| Data | Authority and lifecycle |
| --- | --- |
| Task execution metadata, lease, artifact index | PostgreSQL; board-controlled |
| Published commits | Git remote; publication reconciled by revision and operation identity |
| Active independent checkout, agent sessions, spool | Task-owned PVC; retained until artifacts are acknowledged |
| Workspace checkpoints, raw transcripts, logs, exports | Object storage; immutable scoped generations |
| Dependencies and build caches | Rebuildable, scoped caches; never required for recovery |
| Secrets | Scoped delivery; excluded from workspace checkpoints and artifact configuration |

Use an explicitly managed PVC, not a pod-owned ephemeral PVC. EBS is the proposed EKS backend;
attachment and topology constraints must be proven in the cluster acceptance test. Task and pod
ownership are separate: pod deletion must not garbage-collect the only recoverable task state.
Restore an independent Git checkout, including required untracked files, from a completed manifest.
Do not copy linked worktrees whose Git metadata references a member-wide parent clone.
No EFS mount is needed by the API, driver or runner for normal execution or artifact retrieval.
Workspace provisioning/facts become metadata or task-artifact operations instead of API filesystem reads.

## Blockers and enforcement map

Paths below identify current code/tests to replace or extend, not already implemented support.

| Decision or blocker | Current code | Test anchor |
| --- | --- | --- |
| Multiple images; predeclare containers and reject unsupported plans | `driver/src/k8s-podspec.ts`, `driver/src/k8s-gates.ts` | `driver/test/k8s.test.ts` |
| Setup before execution; same environment for gates | `driver/src/gates.ts`, `driver/src/loop-gates.ts` | `driver/test/gates.test.ts` |
| Service readiness, restart, hostname rewriting and port collisions | `driver/src/k8s-services.ts`, `driver/src/service-restart.ts` | `driver/test/services.test.ts` |
| Helper and reviewer profiles, budgets, snapshot isolation | `driver/src/k8s-helper-runner.ts`, `driver/src/loop-review.ts` | `driver/test/review-executors.test.ts` |
| Secret isolation; no blanket publication credentials in agent env | `driver/src/k8s-podspec.ts`, `driver/src/publish-control.ts` | `driver/test/k8s-admission.test.ts`, `driver/test/publish-control.test.ts` |
| Revision-bound evidence and non-agent-owned verdicts | `driver/src/evidence-policy.ts`, `driver/src/loop-verdict.ts` | `driver/test/evidence-policy.test.ts`, `driver/test/publish-stale.test.ts` |
| Per-stage resource budgets and supervisor survival | `driver/src/k8s-podfields.ts`, `driver/src/config.ts` | `driver/test/k8s.test.ts` |
| Stop, question waits, deadlines, ad-hoc control | `driver/src/control-channel.ts`, `driver/src/run-deadline.ts` | `driver/test/run-control.test.ts`, `driver/test/run-deadline.test.ts` |
| Fencing, restart reconciliation and duplicate side effects | `driver/src/k8s-fence.ts`, `driver/src/k8s-reaper.ts` | `driver/test/k8s-reaper.test.ts`, `driver/test/loop-fence.test.ts` |
| Shared clone/member filesystem assumptions | `server/src/workspace/reconcile.ts`, `driver/src/publish.ts` | `server/test/workspace.reconcile.test.ts`, `driver/test/publish-checkout.test.ts` |
| Session export, buffering, caps and analysis retrieval | `driver/src/close-read.ts`, `driver/src/artifacts.ts`, `cli/src/artifacts.ts` | `driver/test/artifacts.test.ts`, `cli/test/artifacts.test.ts` |
| Docker lifecycle parity | `driver/src/docker-runner.ts`, `driver/src/services.ts` | `driver/test/docker.test.ts`, `driver/test/services.test.ts` |

## Transcript durability and analysis

Persist source transcripts/session databases on the retained volume throughout execution.
An exporter emits immutable chunks continuously: flush at 256 KiB pending or 15 seconds after the
oldest unflushed byte, whichever comes first (sized in the #762 decision below).
Upload retries use bounded disk buffering; exhaustion pauses execution or fails it explicitly,
never silently drops records. A network outage can exceed the remote durability target; expose
oldest unacknowledged age and bytes. The volume remains the recovery source during that outage.

Keys include org, member, task/root, claim sequence, executor, session and stream. Chunk sequence,
content checksum and stable event identity make retries idempotent. A manifest lists acknowledged
chunks, schema/producer version, timestamps, terminal cause and complete/partial/truncated state.
Raw executor records are the analysis source of truth; normalized records retain provenance.
Gate/service logs and supervisor events are separate ordered streams. Scope every read and write.
Reviewers and subagents have their own sessions linked to the parent attempt; token accounting
must preserve existing OTEL/transcript deduplication rather than summing both sources.

Claude JSONL export handles partial trailing records and rotation. OpenCode uses supported exports
or consistent database reads, never a blind live SQLite file copy. Baked hooks/settings survive
session path changes. Reserve artifact path/config environment names against member overrides.
Raw transcripts can contain sensitive tool output: restrict access and provide configurable
retention/deletion; normalized redacted views must not masquerade as lossless raw transcripts.

Agent kill, timeout and pod replacement preserve locally persisted bytes on the retained volume.
An unrecoverable volume/AZ failure can lose unacknowledged bytes; asynchronous uploads cannot
promise zero loss for this case. Report the last acknowledged checkpoint and mark it incomplete.
No writable transcript filesystem is mounted into the API for analysis; readers use the artifact index.

## Completion and recovery

Record task outcome and artifact-finalization status separately. A failed upload does not turn
a passing gate into a failed gate, but prevents a complete-artifact claim and automatic PVC deletion.
Recovery retries export from the retained volume under a fenced claim; resume only from completed
workspace manifests. A stale attempt may finish immutable uploads to its own prefix but cannot
advance the authoritative task checkpoint, verdict or publication state.
Publication uses a persisted operation identity and remote-state reconciliation after uncertain
responses; a local lease check alone cannot undo a remote push or guarantee exactly-once effects.
Reviewer sessions inside the pod use separate credentials, budgets and immutable input snapshots.
Explicit standalone review tasks remain separate task runners; they are not auxiliary Jobs.

## Current state and delivery order

| Surface today | Code | Consequence for this change |
| --- | --- | --- |
| Transcripts read once after exit by a close-read Job, last 512 KiB, upserted per attempt | `driver/src/close-read.ts`, `driver/src/runner.ts`, `server/migrations/046_job_artifacts.sql` | Durable transcripts need no pod consolidation; they ship first |
| Artifact upload requires a live lease | `server/src/db/job-store-worker.ts` | Stale attempts lose transcripts; authorize by claim sequence instead |
| OpenCode export is text-only `{role,time,text}` | `driver/src/scripts/opencode-transcript.cjs` | Raw rows, tool calls and usage are not retained today |
| No object-store code or config | — | S3 on EKS; RustFS in compose and as a `.bellows.yaml` service; filesystem backend for `npm test` |
| Sync, reclaim, publish, helper, gate, readout and close-read Jobs plus service Pods share one RWX PVC | `driver/src/k8s-auxspec.ts`, `driver/src/k8s-podspec.ts`, `charts/factory/templates/pvc.yaml` | EBS is single-node: consolidation must precede EFS removal |
| Service images come from a runtime `.bellows.yaml` readout Job | `driver/src/k8s-services.ts`, `server/src/workspace/bellows.ts` | Resolve gates and services at claim from the claimed revision |
| API clones, provisions, purges and reads facts on the member volume | `server/src/workspace/` | Removed with EFS; facts become metadata |
| Follow-up reuses the per-root worktree and on-volume Claude session; package cache is per member | `driver/src/claim.ts`, `driver/src/scripts/git-worktree.cjs` | Restore needs the checkpoint manifest and lossless raw sessions |

Order: durable transcripts on today's runtime → one task pod on the shared volume → task PVC and
EFS removal → failure-matrix acceptance. Each step lands Kubernetes and Docker together.

Cost risk: pod requests are the sum of every container for the pod's whole life, so in-pod gate,
service and reviewer containers reserve capacity that today's short-lived Jobs release. Measure
before the one-pod phase; no saving is claimed.

## Implementation decisions to close in the first milestone

- Define supported image planning and concurrent service port mapping; fail unsupported plans early.
  `.bellows.yaml` services declare no ports today; the plan needs declared ports or image metadata.
- Size resources and measure attach/startup/restore/upload behavior before setting service objectives.
- Design changes to workspace APIs and artifact UI; require `npm run verify:ui` for rendered changes.

## Decision: in-pod control contract (#761)

Measured on kind v1.37 with `node:24` as the gate image and `postgres:17` as the service, every
container non-root with all capabilities dropped, no service-account token and no shared PID
namespace. Harness: `experiments/task-runner/spike-761/` on the POC branch.

| Concern | Decision | Observed |
| --- | --- | --- |
| Gate control | Declared gate image runs as a native sidecar whose entrypoint is a POSIX loop delivered by ConfigMap; requests and exit codes pass through an emptyDir that only the supervisor and the gate mount | Exit codes propagate; no-op round trip 355–455 ms; the image needs only `sh`, which gates already require |
| Gate isolation | The loop sends `kill -KILL -1` after every request and on cancel | A background process left by one gate could not forge the next result; cancel answered in 50–205 ms and the loop survived |
| Agent boundary | Agent mounts the workspace and a read-only control directory, nothing else | Agent saw no control directory, no publish secret, no token and only its own processes; could reach the service port |
| Services | Native sidecars; `hostAliases` maps declared names to 127.0.0.1; restart = supervisor bumps a generation file, liveness probe fails, kubelet restarts the container with a fresh writable layer | Gate reached `db:5432` by name; restart went down in 0.5–0.7 s and was ready again in 5.6–8.8 s |
| Lifecycle | Supervisor and agent are regular containers; the Job completes when both exit and the sidecars are stopped | Job succeeded with one Job and one pod in the namespace |
| Resources | Pod-level `resources` accepted (Burstable). The driver resizes the gate sidecar in place: low while the agent runs, the `gateResources` request for verify | Sidecar resize from 100m/128Mi to 2/2Gi and back applied in about 0.5 s each, with no restart |

Rejected alternative: ephemeral containers added by the driver. They worked (exit code read via
the API, 2.2 s from add to exit) but take no resource requests, cannot be removed from the pod
spec, need `pods/ephemeralcontainers` RBAC plus admission coverage, and cannot serve services.

Limits:
- Gate code shares the loop's uid, so it can write its own result. That is equivalent to exiting
  0, and the gates already share a writable worktree today.
- Gates run serially, one loop per gate image.
- Service restart needs `sh` and `cat` in the service image; a plan without them is rejected.
- Resize-up can be deferred on a full node. The gate then runs at its low request, bursting to its limit.
- Docker: the same mailbox runs on the task volume; the driver restarts services directly.

Reserved capacity under the chart defaults (runner 500m/1Gi, gate 2 CPU/2Gi, supervisor 100m/128Mi),
for a 30-minute agent run followed by 5 minutes of gates. This is a model, not a fleet measurement:

| Layout | CPU-minutes | GiB-minutes |
| --- | --- | --- |
| Today: runner Job, then gate Jobs | 25 | 40 |
| One pod, static per-container requests | 91 (3.6x) | 109 (2.7x) |
| One pod, gate resized in place for verify | 34 (1.4x) | 53 (1.3x) |

Most of the remaining increase is the exited agent container's requests, which still count while
the gates run. The in-place resize is a hard requirement of the one-pod phase. In-place resize
and pod-level resources are both beta and on by default in Kubernetes 1.34, the EKS version
observed in `docs/kubernetes.md`.

## Decision: supervised steps (#771)

Sync, reclaim, tree probe, review snapshot, publish steps and allowlisted helpers are requests the
driver submits to the attempt's task supervisor, never a Job or container of their own.

| Concern | Decision |
| --- | --- |
| Channel | The supervisor pulls (`GET /step?wait=`, a long poll) from the driver's run-control endpoint under its own token and answers (`POST /step/:id`, `POST /report`). The agent token opens neither route. `driver/src/step-control.ts`, `driver/src/control-channel.ts` |
| Request | `{id, kind, argv, cwd, env, timeoutMs}`; the supervisor runs `argv` as a child process group of its own container (executor image, the task volume mounted read-write at the member subPath) and answers `{exitCode, stdout, stderr, timedOut}`. `driver/src/supervised-steps.ts`, `driver/src/scripts/supervisor.cjs` |
| Lifetime | The group exists from the attempt's first step (the sync), not from the agent's start. The agent container waits on `in/go`; the `go` order releases it and starts the run budget. After the agent ends and the exporter drains, the supervisor reports and keeps serving steps until the `finish` order, a closed token, or a driver silent past `SUPERVISOR_ORPHAN_MS`. A kill, the budget or a full spool end the group without waiting for `finish` |
| Identity | A step id is an operation identity. The supervisor keeps a ledger under its own mailbox and answers a succeeded id from it instead of running it again; a failed or killed step is run afresh. The driver asks an unanswered step again under the same id |
| Credentials | The claim env and the publish-fresh token are the step's own `env`. The supervisor container mounts no Secret of them; the agent container's env never holds a publish token and has no route to the endpoint |
| Publish | `publishCheckout` records an operation `<branch>@<sha>` in the worktree's `.factory/publication.json` (`pushing` → `pushed` → `opened`) and asks the remote (`git ls-remote`, `gh pr view`) after any failed push or PR creation before repeating it. A clean, pushed tree whose ledger says `pushed` opens the missing PR instead of reporting nothing to publish. `driver/src/publish-reconcile.ts` |
| Refusals | The supervisor refuses a `publish` step once the attempt ended any way but completed |
| Reclaim | A thread with no attempt has no group to ask, so its reclaim runs in a supervisor-only group: the one Job a thread without an attempt gets, deleted with the volume by #775 |

## Decision: artifact store (#762)

Evidence, from `experiments/task-runner/spike-762/` on the POC branch:
- Create-only writes on SeaweedFS and on RustFS: the first PUT returned 200; both an identical
  retry and a different body returned 412; the stored body was unchanged.
- MinIO images could not be pulled from Docker Hub or quay.io (2026-10-15).
- Transcript sizes from 277 local Claude sessions (interactive use, not board runs):
  - Session size: p50 522 KiB, p90 2.2 MiB, max 38 MiB.
  - Growth rate: p90 196 KiB/min, max 273 KiB/min.
  - Largest single record: p99 1.1 MiB, max 12 MiB.
  - 140 of the 277 sessions exceed today's 512 KiB cap.

| Concern | Decision | Why |
| --- | --- | --- |
| Write path | Runners upload chunks through the board API; only the API holds store credentials | Driver and runners stay dependency- and credential-free; tenant scoping has one owner; per-session rates are a few KiB/s |
| Client | Minimal SigV4 client in `server/` (PUT with `If-None-Match: *`, GET, HEAD, DELETE); no AWS SDK | Spike client worked against both stores; keys are ASCII ids and integers |
| Credentials | Static keys from a Secret, then EKS Pod Identity, then IRSA web identity; a new dashboard ServiceAccount carries the role binding | The dashboard runs as the `default` ServiceAccount today |
| Off-cluster store | RustFS 1.0.1 in compose (`s3`) and as this repo's `.bellows.yaml` service; filesystem backend for `npm test` and single-replica dev | MinIO publishes no community images. Garage v2.3.0 ignored `If-None-Match` and needs a config file. SeaweedFS needs root or a declared user. RustFS runs hardened from env alone on Docker and kind. `npm test` stays offline |
| Key layout | `<prefix>/<org>/<member>/<root>/<job>/<claimSeq>/<executor>/<session>/<stream>/<offset:012>` | Ids only, no names; the source byte offset is a stable chunk identity |
| Immutability | The index row `(stream, offset, length, sha256)` is unique and inserted before the PUT; a 412 counts as success only when the stored sha256 matches | The store answers 412 to identical retries too, so the index arbitrates |
| Chunking | Byte ranges of the raw source cut at record boundaries; flush at 256 KiB pending or 15 s; a larger record is its own chunk; above 64 MiB the record is cut and marked truncated | p90 growth gives ~50 KiB chunks and at most 240 PUTs per session-hour. The volume is the recovery source, so 15 s bounds only the volume-loss window |
| Spool | Raw source files on the task volume are the spool; derived streams spool to the volume, capped at 1 GiB per attempt; at the cap the attempt fails with cause `artifact_spool_full`; vitals expose oldest-unacknowledged age and bytes | At the highest observed rate, 1 GiB covers more than 60 h of store outage |
| Caps and quota | 1 GiB per stream; above it the manifest is `truncated` with cause `stream_cap`. A per-org byte quota is off by default; when set, refused chunks mark `org_quota` and execution continues | The stream cap is 26 times the largest observed session |
| Retention | Task removal deletes asynchronously through index tombstones; a board sweep deletes after `retentionDays` (default 90); a bucket lifecycle rule is an optional safety net | The index and the store must not disagree |
| Recovery volume | Kept while any manifest is pending; deleted 24 h after all are complete, subject to #763; still pending after 7 days → deleted with manifests marked `lost_unacknowledged` | Bounds cost without silent loss |
| Encryption | SSE-S3 by default; optional KMS key id | — |

Chart values shape (key names are fixed by #764):

```yaml
artifacts:
    backend: s3                 # s3 | filesystem (filesystem: single replica only)
    s3: { bucket: '', region: '', endpoint: '', forcePathStyle: false, prefix: factory/, kmsKeyId: '' }
    credentialsExistingSecret: ''   # empty: Pod Identity or IRSA
    retentionDays: 90
    orgQuotaBytes: 0
dashboard:
    serviceAccount: { create: true, annotations: {} }   # IRSA role-arn annotation
driver:
    artifactFlush: { bytes: 256Ki, seconds: 15, spoolMax: 1Gi, streamMax: 1Gi }
```

## Decision: follow-up continuity and package cache (#763)

Evidence from `experiments/task-runner/spike-763/` on the POC branch:
- `checkpoint-restore.sh` snapshotted a checkout with branch commits, an edit, a deletion, an
  untracked file and an ignored `node_modules/`, then restored it into a fresh clone. `git status`
  matched exactly; the ignored directory was not restored.
- Checkpoint bundles of three real fix branches (2–43 files changed) were 4–44 KiB.
- `npm ci` of this repo took 12 s cold and 8 s from a warm cache (76 MiB, 80 MiB compressed). That
  is one ecosystem on one machine.
- Follow-up delays could not be measured: only fixture databases were reachable. An operator can
  size the TTL on a production board with the query below.

| Concern | Decision |
| --- | --- |
| Follow-up within the idle TTL | The thread's task PVC is reattached as-is: tree, sessions and caches as the last attempt left them. Same as today's RESTORE mode |
| Idle TTL | 24 h after the last attempt finalizes with complete artifacts (deployment setting; the #762 rules for pending artifacts still apply) |
| Checkpoint | Each attempt's finalize stage, after verify/publish and before report, uploads a `checkpoint` stream. It holds a commit of the whole tree made through a throwaway index (untracked files included, ignored files excluded), bundled against the remote default branch and the pushed task branch. The root's checkpoint pointer advances only under a valid claim sequence |
| Restore after the TTL, volume loss or a cross-zone move | Partial clone (`--filter=blob:none`) of the default branch, fetch the bundle, switch the task branch to the checkpoint's parent, `read-tree -u --reset` to the checkpoint, then reset the index |
| Agent sessions | The task volume is always mounted at one fixed path, so Claude's cwd-derived project directory is stable. Claude JSONL is rebuilt byte-for-byte from the raw chunks of every session in the thread. OpenCode restores a database snapshot (SQLite backup) taken at finalize as part of the checkpoint |
| Retry | Unchanged: fresh session; the sync rebases onto the default branch with `--autostash`, conflicts go to the agent. After the TTL, restore runs first |
| Ignored files | Not checkpointed. `environment.setup` already runs once per attempt and rebuilds them |
| Package cache | No persistent cross-task cache in this change. `environment.cache` names point into the task volume, so they persist across follow-ups within the TTL only. An object-store cache keyed by org, repo and lockfile hash is a possible later addition and must never be needed for recovery |

Limits:
- Restore leaves every uncommitted change unstaged; the staged/unstaged split is not kept.
- A checkpoint bundle above 256 MiB is marked truncated.
- A truncated checkpoint, or one whose prerequisite commit is no longer reachable on the remote
  (for example after a force-push), fails the follow-up explicitly with cause
  `checkpoint_unrestorable`. A fresh retry from the pushed branch stays available.
- Docker uses the same per-root volume, TTL and checkpoint path.

Follow-up delay on a board (replace the interval to taste):

```sql
select percentile_cont(array[0.5, 0.9, 0.99]) within group (order by f.created_at - p.finished_at)
from job f join job p on p.org_id = f.org_id and p.id = f.parent_job_id
where f.root_job_id <> f.id and p.finished_at is not null and f.created_at > now() - interval '30 days';
```
