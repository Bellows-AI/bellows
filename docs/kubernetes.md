# Kubernetes

The primary executor — runners are Jobs the driver reconciles itself, no CRD — and the chart deploying it.

## Where things live

| Concern | Code | Test |
| --- | --- | --- |
| The `Runner` seam both executors implement; executor-neutral state (paths, claim env, outcome parsing, container scripts, argv plan); wire types, transport (a pod log past its stream buffer is answered as its tail, flagged `truncated`), protocol constants | `driver/src/runner.ts`, `k8s-runner.ts`, `claim.ts`, `close-read.ts`, `container-scripts.ts`, `runner-plan.ts`, `k8s-transport.ts` | `driver/test/k8s.test.ts`, `k8s-transport.test.ts`, `scripts.test.ts`, `runner-plan.test.ts`, `close-read.test.ts` |
| Job specs: the runner, the only Job that mounts the task volume while its group lives (the close-time readouts are supervised `probe` steps, `runReadoutStep`; an adopted ended group's run as a one-shot reader Job, `readerJobSpec`, `k8s-reader.ts`), the pod's supervisor, agent and claude transcript exporter containers, `gate` and `svc-<name>` native sidecars, `emptyDir` mailboxes, the supervisor's optional read-only `binding.json` Secret volume, per-attempt Secret names, resource and scheduling fields | `driver/src/k8s-podspec.ts`, `k8s-auxspec.ts`, `k8s-podfields.ts`, `k8s-reader.ts` | `driver/test/k8s.test.ts`, `driver/test/k8s-reader.test.ts` |
| The thread's task volume: one claim per root thread, `factory-task-<root uuid>-<generation>`, created (or read back) at the end of `prepare` and mounted at `/task` by every container; the reviewer mounts its `.factory/reviewer` subPath, prepared by the `task-init` init container; the chart's `taskVolume.{storageClass,accessMode,size}` ride `TASK_VOLUME_*`, `REPO_CLONE_BASE` names the clone origin; admission admits only that claim name and shape; a task pod held Pending by `volume node affinity conflict` past `GROUP_UP_WAIT_MS` is an infrastructure loss (only when every node refused it by affinity, and only under the held claim) that labels its claim `factory.task-unschedulable`; the next claim restores into a new generation and deletes the stuck one after, or adopts it again, label cleared, when no complete checkpoint exists, and a volume whose zone never returns spends the interruption budget (`INTERRUPTION_BUDGET`, `server/src/db/job-store-actions.ts`) until the task ends; docker has no zones, so no analogue; only the reaper deletes a claim, every generation of an idle thread together ([workspace.md](workspace.md)) | `driver/src/task-volume.ts`, `k8s-reaper.ts` (`scanVolumes`), `k8s-fence.ts` (`taskVolumePresent`), `k8s-task-volume.ts` (`markTaskVolumeUnschedulable`), `k8s-group.ts` (`awaitSupervisor`), `k8s-podspec.ts`, `docker-task-volume.ts`, `scripts/task-checkout.cjs`, `scripts/task-init.sh`, `charts/factory/templates/driver-admission.yaml`, `driver-rbac.yaml` | `driver/test/k8s.test.ts`, `driver/test/docker-task-volume.test.ts`, `driver/test/k8s-task-volume.test.ts`, `driver/test/k8s-reaper.test.ts`, `driver/test/k8s-group.test.ts`, `driver/test/scripts-task-checkout.test.ts`, `driver/test/k8s-admission.test.ts`, `scripts/test-k8s.sh` |
| The task group: one Job per attempt, created by its first step (the sync) and ended by the loop's `finish`, not by the agent's exit; the agent container waits on `in/agent/go`; a reclaim is an acked no-op (nothing is linked to remove); sync, probe, publish, helpers, reviews and a live group's close-time session readouts are no Jobs | `driver/src/k8s-group.ts`, `k8s-runner.ts`, `k8s-podspec.ts` | `driver/test/k8s-group.test.ts`, `driver/test/k8s.test.ts` |
| The re-claim fence, the polling it brackets, what a Stop mid-run leaves, a runner Job deleted under its run (`RunnerVanished`, an infrastructure loss) | `driver/src/k8s-fence.ts`, `k8s-poll.ts`, `k8s-kill.ts` | `driver/test/k8s.test.ts`, `k8s-fence.test.ts` |
| The cooperative Stop and draft publication: `SUPERVISOR_CONTROL_*` rides the per-attempt Secret into the supervisor container only and polls the driver pod's IP; it also holds the agent's and the exporter's tokens and serves them a relay socket (`serveRelay`) in their mailboxes, attaching the role's token, so the agent's control proxy and the exporter hold no credential; the supervisor has no ServiceAccount token | `driver/src/k8s-podspec.ts`, `loop-gates.ts`, `loop-publish.ts`, `driver/src/scripts/supervisor.cjs` | `driver/test/k8s.test.ts`, `driver/test/publish-control.test.ts`, `driver/test/supervisor.test.ts` |
| Gates in the `gate` native sidecar, resized in place (`pods/resize`) idle before `go` and to the gate requests for verify; sizing `GATE_*` (chart `runner.gateResources`) over `RUNNER_*`, docker renders the same; declared services (the claim's `services`) as `svc-<name>` sidecars named on the pod's loopback, restarted by a generation bump their liveness probe reads | `driver/src/k8s-gate.ts`, `k8s-services.ts`, `k8s-podfields.ts` (`gateRequests`), `docker-group.ts` (`gateCreateArgs`), `scripts/service-generation-*.sh`, `charts/factory/templates/driver-rbac.yaml` | `driver/test/k8s.test.ts`, `driver/test/docker-group.test.ts`, `scripts/test-k8s.sh` |
| Supervised steps (sync, tree probe, review snapshot, publish, allowlisted helpers) are requests the supervisor pulls (`GET /step`) and runs in its own container; credentials ride the step; a Job ending with no report taken, or a kill, fails waiting steps at once | `driver/src/supervised-steps.ts`, `step-control.ts`, `control-channel.ts`, `review-snapshot.ts`, `supervisor-plan.ts`, `scripts/supervisor.cjs` | `driver/test/supervised-steps.test.ts`, `step-control.test.ts`, `supervisor.test.ts`, `review-snapshot.test.ts` |
| A claim listing `reviewerProfiles` adds one dormant `reviewer` native sidecar (executor image, `REVIEWER_UID` 1002, resized in place by `resizeReviewer`): task volume read-only, a review mailbox shared with the supervisor alone, home `.factory/reviewer` (made by the `task-init` init container), model credentials only; a named reviewer runs there as `review` steps under the review row's lease, its checkout in `<task tree>.reviews/` on the task volume, a per-review opencode data dir (`reviewerDataName`); admission admits it as the one other restartable name | `driver/src/k8s-podspec.ts` (`reviewerSidecar`), `k8s-gate.ts`, `k8s-podfields.ts` (`reviewerRequests`), `review-step.ts`, `loop-review.ts` (`superviseReview`), `scripts/review-loop.sh`, `charts/factory/templates/driver-admission.yaml` | `driver/test/k8s.test.ts` (`a full attempt`), `k8s-admission.test.ts`, `review-step.test.ts`, `scripts-review-loop.test.ts` |
| Publish, revision-bound evidence and agent-opened PRs as the same supervised steps over both executors; a persisted operation (`<branch>@<sha>`) and a remote read after any uncertain answer keep a retry from pushing or opening twice | `driver/src/publish.ts`, `publish-reconcile.ts`, `evidence-policy.ts`, `loop-verdict.ts`, `docker/claude-executor/git-guard.cjs` | `driver/test/publish-checkout.test.ts`, `publish-hooks.test.ts`, `publish-reconcile.test.ts`, `docker.test.ts` |
| Failure cause (`verification`/`conflict`/`denied`/`config`/`transport`/`environment`/`unknown`) classified once over both executors; a refused group start (`StartupRefused`: transient/image/auth/config), a pod still coming up at `GROUP_UP_WAIT_MS` transient, a pod seen and then gone or marked a disruption target before first contact transient at once | `driver/src/publish.ts` (`publishCauseOf`), `gate-cause.ts`, `loop-ledger.ts` (`causeOf`), `startup-cause.ts`, `k8s-poll.ts` (`startRefusalOf`, `disrupted`), `k8s-group.ts` (`awaitSupervisor`) | `driver/test/k8s-group.test.ts`, `publish-cause.test.ts`, `gate-cause.test.ts`, `startup-cause.test.ts`, `k8s.test.ts`, `docker.test.ts` |
| Same image, same argv (the Jira connector's `JIRA_API`, the AskUserQuestion bridge, selected skills); a question wait removes the runner Job's `activeDeadlineSeconds` and restores it after answers (`patch` on `jobs`) | `docker/claude-executor/entrypoint.sh`, `claude-bridge.cjs`, `driver/src/loop-run.ts`, `k8s-runner.ts` | `driver/test/executor-images.test.ts`, `claude-bridge.test.ts`, `k8s.test.ts`, `scripts/test-k8s.sh` |
| Ending, creating and adopting runner Jobs: suspended create, Secret owned by the Job's uid, resume after verify; `TeardownIdentity` names every resume, suspend and delete by uid; `ended` only from live writer-pod confirmation, then `releaseClaimAfterGroupEnd`; a finished Job (`factory.claim-seq`, `factory.session`) is adopted by the next claim, never reaped unread; a lost supervisor leaves the attempt interrupted, never failed; `AdoptionBlocked` leaves it to its lease | `driver/src/k8s-teardown.ts`, `k8s-fence.ts`, `k8s-adopt.ts`, `k8s-reaper.ts`, `reaper.ts`, `k8s-group.ts` | `driver/test/k8s.test.ts`, `k8s-reaper.test.ts`, `k8s-group.test.ts`, `scripts/test-k8s.sh` |
| Checkout-claim ownership: each acquisition holds the claim under its own token, and a claim is deleted only once every group of its holder is confirmed ended | `driver/src/k8s-fence.ts` (`releaseClaimAfterGroupEnd`), `loop-reclaim.ts` | `driver/test/k8s.test.ts`, `k8s-fence.test.ts`, `scripts/test-k8s.sh` |
| Every `EXECUTOR`, `K8S_*`, `RUNNER_*` and `GATE_*` variable with its boot validation; the app chart (dashboard, driver, collector, RBAC, PDBs, Ingress, `LimitRange`) | `driver/src/config.ts`, `charts/factory/` ([README](../charts/factory/README.md)) | `driver/test/config.test.ts`, `scripts/test-k8s.sh` |
| Admission policies fencing the driver (one capability add: `SETUID`/`SETGID` on a runner Job's `agent`; two updates: a task volume claim's unschedulable label, an attempt Secret's holder binding); runner network confinement | `charts/factory/templates/driver-admission.yaml`, `runner-networkpolicy.yaml`, `driver/src/k8s-podfields.ts` | `driver/test/k8s-admission.test.ts`, `scripts/test-k8s.sh` (`--cluster`, `--netpol`) |
| Local Postgres, `.env`-fed local values, `make start`/`reset`; the kind cluster and registry, `make cluster`/`cleanup` | `charts/factory-local-state/`, `scripts/k8s-local-values.mjs`, `scripts/kind-cluster.sh`, `Makefile` | `scripts/test-k8s.sh`, `driver/test/k8s-lane.test.ts`, `core/test/makefile.kind-cluster.test.ts` |

## Invariants

- **Executor parity** (AGENTS.md): a `k8s-*.ts` importing from `docker*.ts` belongs in a neutral file.
- **An unconfirmed read is inconclusive, never empty**: a failed, timed-out, null or malformed answer stays a typed
  `Read` the caller leaves alone. `lint/no-silent-empty-read.grit`, `driver/test/k8s-read-faults.test.ts`.
- **Credentials go by reference, never by value**, and **runner pods hold no ServiceAccount token**
  (`automountServiceAccountToken: false`). Both pinned in `driver/test/k8s.test.ts`.
- **Every driver-owned object carries `factory.job`**, every Secret follows `factory-job-…-env`, every
  task volume mount is whole or at the reviewer's home (`REVIEWER_TREE_DIR`), `hostAliases` map only to
  `127.0.0.1` and only the `gate`, `reviewer` and `svc-` sidecars restart — or admission refuses it. `driver/test/k8s-admission.test.ts`.
- **The agent container's env holds no GitHub token and no route to the step channel**; the claim env and the
  board's GitHub token are a step's own `env`, and the agent's helper caches its own in a Memory `emptyDir`.
  `driver/test/supervised-steps.test.ts`, `driver/test/github-credential.test.ts`.
- **The fence orders contenders by `claim_seq`, never by a clock or the refundable attempt counter.**
  `driver/test/k8s.test.ts` (`after its attempt was refunded`, `no claim sequence`).
- **A runner group whose driver is lost ends inside its lease** (`orphanBoundMs`, `driver/src/supervisor-plan.ts`;
  30 s floor under a 120 s lease) and is adopted; lost before `go`, its supervisor exits `SUPERVISOR_EXIT.lost` and
  the run is redone, never adopted; a released group (its agent went, `supervisor: released the agent`) waits
  `takeoverBoundMs` (the lease plus `SUPERVISOR_REBIND_GRACE_MS`) for a newer holder instead.
  `driver/test/supervisor.test.ts`, `driver/test/scripts-claude-export.test.ts`, `driver/test/k8s.test.ts`.
- **The driver never reads a Secret back** — the Role grants no `get`/`list`; attempt Secrets are reaped by
  derived name; the binding patch's answer is discarded unread.
- **`make start` refuses a state claim initialised without `PGDATA`** and a pre-StatefulSet state release; both name
  `make reset`. `core/test/makefile.state-preflight.test.ts`.
- Stated limit: a runner still RUNNING when its driver is lost, its agent released by the supervisor, is taken over:
  the next claim rebinds the supervisor (`rebind`), the supervisor must poll the new endpoint within
  `SUPERVISOR_REBIND_DELIVERY_MS`, and no sync, setup or `go` follows; one never released is swept by the next
  claim's re-claim fence and the job redone in its session and tree, an interruption inside the budget; one whose agent exited is taken over the same way while its supervisor
  still serves (no `supervisor: stopped serving the steps`), its report delivered to the new holder; one whose supervisor stopped serving is waited out (`finalizeWaitMs`,
  `driver/src/supervisor-plan.ts`) and adopted with its logged report, and a lost driver still alive steps into it until it learns its lease was lost, then hangs up on the
  group's tokens (`depart`), the wait outlasting that learning (one heartbeat) and the group's `takeoverBoundMs`.
  A finished one is adoptable until its Job's one-hour `ttlSecondsAfterFinished`.
  `driver/src/k8s-adopt.ts`, `driver/src/docker-close-read.ts`.
- A taken-over run's agent and exporter reach the new holder through the supervisor's relay (`serveRelay`); a
  request in flight across the rebind is hung up on (the exporter retries it; the agent's proxy answers 502), and
  the transcript continues under the new claim from its first unacknowledged byte.
  `driver/test/supervisor.test.ts`, `driver/test/control-proxy.test.ts`.
- Stated limit: a taken-over run's agent gate requests (`BELLOWS_GATE_*`) keep the lost driver's endpoint; the
  end-of-run gates run on the new holder (follow-up #909). `driver/src/loop-gates.ts`.
- Stated limit: a driver cut off from the board but still reachable by its supervisor never learns its lease was
  lost (`beat()` swallows failed heartbeats), so it keeps contact past the adopter's finalize wait; the adopter
  then sweeps and redoes the run (kubernetes) or is blocked until the supervisor ends (docker).
  `driver/src/loop-attempt.ts`.
- Stated limit: a rebind reaches a live supervisor only once the kubelet refreshes the attempt Secret's volume —
  up to its sync period (default one minute) plus its cache delay; docker's write is seen on the supervisor's next
  control poll. `driver/src/k8s-binding.ts`.
- Stated limit: a takeover needs `driver.rebindGraceMs` to outlast that refresh (~60 s measured); a shorter grace ends
  the group before the new holder's binding arrives. `charts/factory/values.yaml`, `scripts/test-k8s.sh`.
- Stated limit: why a driver ended a run is recorded on the attempt only where it outlives the kill — a hard-kill
  deletes the Job, its record, its Secrets and its claim before `end` reaches the board, a refused record is
  none — and such a run is redone in its tree and session. `driver/src/termination.ts`,
  `driver/src/k8s-runner.ts` (`killRunner`), `driver/src/k8s-adopt.ts`, `driver/src/docker-close-read.ts`.
- Stated limit: a verdict neither staged nor completed within one lease leaves its group and checkout claim to the
  next claim: its agent outcome is adopted and resumes after the last post-run phase checkpointed on the board (`gates`
  bound to the tree's fingerprint, then `post`, `publish`); a phase whose checkpoint is missing, unreadable or bound to
  another tree runs again, with every phase after it, and an attempt with no budget left can retire `dead` before it is
  adopted. `driver/src/loop-conclusion.ts` (`end`), `driver/src/loop-phase-checkpoints.ts`.
- Stated limit: a declared service image needs `sh`, `cat` and a writable `/tmp` — its liveness probe
  (`driver/src/scripts/service-generation-probe.sh`) fails on every run without them.
- Stated limit: the kubernetes question round trip (a real claude CLI through the bridge)
  is not run on a kind cluster — the cluster lane installs the stub executor image. The relay is pinned offline in
  `driver/test/k8s.test.ts` and run through the supervisor with the stub's question (`--phase control`); docker's lane is `ask_roundtrip_lane` in `scripts/test-jobs.sh`.
- `make reset` destroys the local state release and its data; the `volumeClaimTemplate` claim survives `helm uninstall`.
- `EXECUTOR=kubernetes` with `RUNNER_CACHE_WATCH=1` is fatal at startup (`driver/src/config.ts`).
- Deliberate docker divergences: no cpu-request flag, no node scheduling, no `imagePullSecrets` twin, no admission
  equivalent; the docker fence keeps its label-sweep shape; on docker (development only) service listeners are
  reachable by IP on the compose network (`driver/src/docker-mailbox.ts`, `groupNetworkArgs`).

## EKS prerequisites

Each is silent when wrong. Walk: [eks-runbook.md](eks-runbook.md); measured claims: [limits.md](limits.md).

- **Node-level IMDS defence** — `httpPutResponseHopLimit: 1` on the runner node group.
- **The VPC CNI add-on needs `enableNetworkPolicy: true`**, enforcing only on EC2 Linux nodes — not Fargate, not
  Windows. Without it the NetworkPolicy is admitted and inert.
- **Every runner pod is a Job's** — the driver creates no bare pod — closing AWS's standalone-pod caveat
  (`charts/factory/templates/driver-rbac.yaml`).
- **metrics-server is not installed by default** (vitals read null), and **`blockedCidrs` blocks the VPC too** — a
  runner that must reach a VPC endpoint needs that host in `isolation.allowedCidrs` as a /32.

### The task volume

The driver mints one claim per root thread. The chart's default (`taskVolume.storageClass: ''`) fits kind and
nothing on EKS, whose default class is not an EBS class the CSI add-on serves. It needs:

1. **The EBS CSI driver add-on, running** — its controller bound to an IAM role by IRSA or EKS Pod Identity.
2. **A StorageClass with `provisioner: ebs.csi.aws.com`**, `volumeBindingMode: WaitForFirstConsumer`, `type: gp3`
   and `reclaimPolicy: Delete`; then `taskVolume.storageClass`. The operator creates it ([eks-runbook.md](eks-runbook.md)).

The volume is zonal: its pods run in the zone it was created in, and a zone with no capacity ends the task as
`factory.task-unschedulable`. **Only the driver's task pods set `fsGroup`** (`core/test/docs.eks-storage.test.ts`),
which is what makes the block volume writable by uid 1000. Whether `ReadWriteOncePod` binds on the EBS CSI driver
has **never been observed**, nor has the chart **been installed on EKS**.

## Isolation: assumptions and residuals

Controls, why Pod Security `restricted` cannot admit the agent container, and that none of this is kernel or VM
isolation: [security.md](security.md). The deployment must provide **A CNI that enforces NetworkPolicy**,
**ValidatingAdmissionPolicy, native sidecars and `pods/resize`, Kubernetes ≥ 1.33**, the IMDS defence. Residuals:

- **IPv6 egress is not covered**; every rule is IPv4.
- A runner can **reach the driver pod on any port** (the gate endpoint has an ephemeral port). Runner pods take no
  ingress, so one attempt cannot reach another (`--netpol` pins it denied); a declared service name resolves to
  `127.0.0.1` through `hostAliases`, never through DNS (#296).
- An apiserver or node address that is **PUBLIC is not covered** by `blockedCidrs`. A NetworkPolicy also
  **says nothing about HTTP routes**.
- **A thread's disk is its task volume's `taskVolume.size` request**, a cap only where the provisioner enforces it; one run can fill its own volume, no one else's. Reviewer files sit on the task volume the agent mounts too, so `REVIEWER_UID` separates signals, not files. A fresh opencode review lost before export cannot resume. An idle reviewer holds 50m CPU / 64Mi (`reviewerRequests`) for the pod's life.
- A runner mounts its thread's task volume, never the member subtree ([workspace.md](workspace.md)). A runner pod gone before the verdict
  read uploads no log, and a log the kubelet rotated (`containerLogMaxSize`) uploads its newest file only, unflagged.
