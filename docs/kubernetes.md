# Kubernetes

The primary executor — runners are Jobs the driver reconciles itself, no CRD — and the chart deploying it.

## Where things live

| Concern | Code | Test |
| --- | --- | --- |
| The `Runner` seam both executors implement; executor-neutral state (paths, claim env, outcome parsing, container scripts, argv plan); wire types, transport, protocol constants | `driver/src/runner.ts`, `k8s/k8s-runner.ts`, `claim.ts`, `close-read.ts`, `container-scripts.ts`, `runner-plan.ts`, `k8s/k8s-transport.ts` | `driver/test/k8s/`, `k8s-transport.test.ts`, `scripts.test.ts`, `runner-plan.test.ts`, `close-read.test.ts` |
| Job specs: the runner, the only Job that mounts the task volume while its group lives (close-time readouts are supervised `probe` steps; an adopted ended group's run is a one-shot reader Job), the pod's supervisor, agent and transcript exporter containers, `gate` and `svc-<name>` native sidecars, `emptyDir` mailboxes, the supervisor's optional read-only `binding.json` Secret volume, per-attempt Secret names, the reaper's one-shot export Job `factory-export-<root>` with its per-export `factory-job-export-<run>-env` Secret | `driver/src/k8s/k8s-podspec.ts`, `k8s-auxspec.ts`, `k8s-podfields.ts`, `k8s-reader.ts`, `k8s-volume-export.ts` | `driver/test/k8s/`, `k8s-reader.test.ts`, `k8s-reaper-export.test.ts` |
| The CLI/tool uid sharing contract holds in the pod unchanged: the attempt Secret is mounted as the one managed-settings file (`subPath`), never over `/etc/claude-code`, and nothing is mounted over the contract's paths; same image, same argv (Jira helper, AskUserQuestion bridge, skills), a question wait removes the runner Job's `activeDeadlineSeconds` and restores it after answers | `driver/src/telemetry-config.ts`, `docker/executor-common/factory-tool.cjs`, `docker/claude-executor/entrypoint.sh`, `claude-bridge.cjs` | `driver/test/k8s/pod-spec.test.ts`, `tool-broker.test.ts`, `executor-images.test.ts`, `claude-bridge.test.ts` |
| The thread's task volume: one claim per root thread, `factory-task-<root uuid>-<generation>`, mounted at `/task` by every container, the reviewer at its `.factory/reviewer` subPath; `taskVolume.{storageClass,accessMode,size}` ride `TASK_VOLUME_*`; a pod held Pending by `volume node affinity conflict` past `GROUP_UP_WAIT_MS` is an infrastructure loss that labels its claim `factory.task-unschedulable`, and the next claim restores into a new generation; docker has no zones, so no analogue; only the reaper deletes a claim ([workspace.md](workspace.md)) | `driver/src/task-volume.ts`, `k8s/k8s-reaper.ts` (`scanVolumes`), `k8s/k8s-fence.ts`, `k8s/k8s-task-volume.ts`, `k8s/k8s-group.ts` (`awaitSupervisor`), `docker/docker-task-volume.ts`, `scripts/task-checkout.cjs`, `scripts/task-init.sh`, `charts/factory/templates/driver-admission.yaml`, `driver-rbac.yaml` | `driver/test/k8s/`, `docker-task-volume.test.ts`, `k8s-task-volume.test.ts`, `k8s-reaper.test.ts`, `k8s-group.test.ts`, `scripts-task-checkout.test.ts`, `k8s-admission.test.ts`, `scripts/test-k8s.sh` |
| The task group: one Job per attempt, created by its first step (the sync) and ended by the loop's `finish`, not by the agent's exit; the agent container waits on `in/agent/go`; the re-claim fence, `RunnerVanished` (an infrastructure loss), `LeftoverTerminating` (a blocked interruption); the agent's gate pair is minted before the first runner step, because a pod's env cannot change after the sync makes it | `driver/src/k8s/k8s-group.ts`, `k8s-runner.ts`, `k8s-fence.ts`, `k8s-poll.ts`, `k8s-kill.ts`, `loop/loop-gates.ts` (`mintGateCredentials`), `loop/loop-run.ts` | `driver/test/k8s-group.test.ts`, `k8s/`, `k8s/leftover-terminating.test.ts`, `k8s-fence.test.ts`, `loop/setup-and-gates.test.ts`, `k8s/pod-spec.test.ts` |
| The `inputs` step runs in the supervisor like the restore and sync steps (`syncCheckout`), before the agent is released; a command-only job gets its group there; no limit against docker | `driver/src/k8s/k8s-runner.ts`, `driver/src/task-inputs.ts` | `driver/test/k8s-restore.test.ts`, `driver/test/task-inputs.test.ts` |
| The cooperative Stop and draft publication: `SUPERVISOR_CONTROL_*` rides the per-attempt Secret into the supervisor container only; it also holds the agent's and the exporter's tokens and serves them a relay socket (`serveRelay`), so the agent's control proxy and the exporter hold no credential; the supervisor has no ServiceAccount token; Supervised steps (sync, tree probe, review snapshot, publish, allowlisted helpers) are requests the supervisor pulls (`GET /step`) and runs in its own container, `git` resolving to the hardened wrapper (`SUPERVISOR_GIT_HARDEN_SCRIPT`, [security.md](security.md)); a Job ending, or a kill, fails waiting steps at once | `driver/src/k8s/k8s-podspec.ts`, `loop/loop-gates.ts`, `loop/loop-publish.ts`, `scripts/supervisor.cjs`, `driver/src/supervised-steps.ts`, `step-control.ts`, `control-channel.ts`, `review/review-snapshot.ts`, `supervisor-plan.ts`, `scripts/supervisor.cjs`, `scripts/git-harden.cjs`, `group-watch.ts` | `driver/test/k8s/`, `publish-control.test.ts`, `supervisor.test.ts`, `driver/test/supervised-steps.test.ts`, `step-control.test.ts`, `supervisor-plan-hardening.test.ts`, `supervisor.test.ts`, `review-snapshot.test.ts`, `group-watch.test.ts`, `k8s-adopt.test.ts` |
| Gates in the `gate` native sidecar, resized in place (`pods/resize`); sizing `GATE_*` (chart `runner.gateResources`) over `RUNNER_*`; `GATE_FILTER` is the gate step's env on both executors; declared services as `svc-<name>` sidecars on the pod's loopback, restarted by a generation bump their liveness probe reads | `driver/src/k8s/k8s-gate.ts`, `k8s-services.ts`, `k8s-podfields.ts` (`gateRequests`), `docker/docker-group.ts` (`gateCreateArgs`), `supervised-steps.ts`, `scripts/service-generation-probe.sh`, `charts/factory/templates/driver-rbac.yaml` | `driver/test/k8s/`, `k8s/gates-and-reviewer.test.ts`, `docker-group.test.ts`, `scripts/test-k8s.sh` |
| One implementation over both executors: the gate-run record and tree probes inside the checkout's queue (`createSupervisedGateManager`); the PR operation record by `publishCheckout` (`prOperationRecorder`); publish, revision-bound evidence and agent-opened PRs as supervised steps, a persisted `<branch>@<sha>` operation and a remote read after any uncertain answer | `driver/src/gates.ts`, `supervised-steps.ts`, `scripts/git-probe.cjs`, `publish/publish.ts`, `publish/publish-pr.ts`, `publish/publish-reconcile.ts`, `evidence-policy.ts`, `loop/loop-pr-operation.ts`, `loop/loop-verdict.ts` | `driver/test/gates-records.test.ts`, `loop/gate-reuse.test.ts`, `runner-contract.test.ts`, `publish-checkout.test.ts`, `publish-reconcile.test.ts`, `loop/publication.test.ts` |
| A claim listing `reviewerProfiles` adds one dormant `reviewer` native sidecar (`REVIEWER_UID` 1002, resized by `resizeReviewer`): task volume read-only, a review mailbox shared with the supervisor alone, model credentials only; reviews run there as `review` steps under the review row's lease; admission admits it as the one other restartable name; a lost review appends the sidecar's state, restarts and last log lines | `driver/src/k8s/k8s-podspec.ts` (`reviewerSidecar`), `k8s-podfields.ts` (`reviewerRequests`), `review/review-step.ts`, `loop/loop-review.ts` (`superviseReview`), `scripts/review-loop.sh`, `k8s-gate.ts` (`runReviewInGroup`) | `driver/test/k8s/` (`a full attempt`), `k8s-admission.test.ts`, `review-step.test.ts`, `scripts-review-loop.test.ts`, `k8s-review-state.test.ts` |
| Failure cause (`verification`/`conflict`/`denied`/`config`/`transport`/`environment`/`unknown`) classified once over both executors; a refused group start (`StartupRefused`), a pod still coming up at `GROUP_UP_WAIT_MS`, a pod gone or a disruption target before first contact | `driver/src/publish/publish.ts` (`publishCauseOf`), `gate-cause.ts`, `loop/loop-ledger.ts` (`causeOf`), `startup-cause.ts`, `k8s/k8s-poll.ts` (`startRefusalOf`, `disrupted`) | `driver/test/publish-cause.test.ts`, `gate-cause.test.ts`, `startup-cause.test.ts`, `k8s-group.test.ts` |
| Ending, creating and adopting runner Jobs: suspended create, Secret owned by the Job's uid, resume after verify; `TeardownIdentity` names every resume, suspend and delete by uid; `ended` only from live writer-pod confirmation, then `releaseClaimAfterGroupEnd`; a finished Job (`factory.claim-seq`, `factory.session`) is adopted by the next claim, never reaped unread; `AdoptionBlocked` leaves it to its lease; each acquisition holds the checkout claim under its own token | `driver/src/k8s/k8s-teardown.ts`, `k8s-fence.ts`, `k8s-adopt.ts`, `k8s-reaper.ts`, `reaper.ts`, `loop/loop-adopt.ts`, `loop/loop-reclaim.ts` | `driver/test/loop-adopt.test.ts`, `k8s/`, `k8s-reaper.test.ts`, `k8s-fence.test.ts`, `scripts/test-k8s.sh` |
| Every `EXECUTOR`, `K8S_*`, `RUNNER_*` and `GATE_*` variable with its boot validation; the app chart ([README](../charts/factory/README.md)); admission policies fencing the driver; runner network confinement; MCP (`mcp.enabled`) is https-only and reaches the board through the one `/` Prefix ingress rule per host (`/.well-known/oauth-*`, `/api/mcp`), no second path rule | `driver/src/config.ts`, `charts/factory/`, `charts/factory/templates/driver-admission.yaml`, `runner-networkpolicy.yaml`, `ingress.yaml`, `validate.yaml`, `driver/src/k8s/k8s-podfields.ts` | `driver/test/config.test.ts`, `k8s-admission.test.ts`, `scripts/test-k8s.sh` (`--cluster`, `--netpol`; the `mcp` phase runs `scripts/mcp-kind-client.mjs`) |
| Local Postgres, `.env`-fed local values, `make start`/`reset`; the kind cluster and registry, `make cluster`/`cleanup` | `charts/factory-local-state/`, `scripts/k8s-local-values.mjs`, `scripts/kind-cluster.sh`, `Makefile` | `scripts/test-k8s.sh`, `driver/test/k8s-lane.test.ts`, `core/test/makefile.kind-cluster.test.ts` |
| The orphan floor and `GET /step` long poll a lane lowers with its lease (`driver.orphanMinMs`/`driver.stepWaitMs`); `loadDriverConfig` refuses a floor under the long poll + 5 s or one the lease cannot hold; the docker lane keeps the 30 s floor | `driver/src/supervisor-contract.ts` (`orphanConfigFault`), `driver/src/config.ts`, `charts/factory/values.yaml` | `driver/test/config.test.ts`, `k8s-lane.test.ts`, `takeover-sim.test.ts`, `takeover-gremlin.test.ts` |
| `driver.metricsPort` (`DRIVER_METRICS_PORT`, default `9464`): the driver's scrape listener on the pod IP, reachable from runner pods like any driver port, so it answers only `Authorization: Bearer $JOB_BOARD_TOKEN`; no Service, no scrape annotations | `charts/factory/templates/driver-deployment.yaml`, `driver/src/metrics-server.ts` | `driver/test/metrics-server.test.ts`, `k8s-docs.test.ts` |
| The secret store: `secretStore.backend` (`database`, `aws` or `vault`, no default), its keys in the `<release>-factory-secret-store` Secret referenced by the dashboard container only; `eks.amazonaws.com/skip-containers: wait-for-database` always set (limit: EKS Pod Identity has no per-container exclusion, so its credentials reach the init container too); rotation runs `rotate-cli.js` in the dashboard container ([secrets.md](secrets.md)) | `charts/factory/templates/secret.yaml`, `deployment.yaml`, `validate.yaml`, `server/src/secrets/rotate-cli.ts` | `scripts/test-k8s.sh` |

## Invariants

- **Executor parity** (AGENTS.md): a `k8s-*.ts` importing from `docker*.ts` belongs in a neutral file.
- **The orphan reaper is scoped to its own driver on both executors, by an identity that survives a restart.**
  Docker stamps `factory.board` (`boardIdentity`); kubernetes selects `app.kubernetes.io/instance=<K8S_RELEASE>`.
  Stated limit: a driver started with no `K8S_RELEASE` is unscoped, so one namespace holds one board.
  `driver/src/k8s/k8s-reaper.ts` (`selectorFor`), `driver/test/k8s-reaper.test.ts`, `driver/test/docker-reaper-boards.test.ts`.
- **An unconfirmed read is inconclusive, never empty**: a failed, timed-out, null or malformed answer stays a typed
  `Read` the caller leaves alone. `lint/no-silent-empty-read.grit`, `driver/test/k8s-read-faults.test.ts`.
  `driver/src/k8s/k8s-shapes.ts`, `driver/test/k8s-transport.test.ts`.
- **Credentials go by reference, never by value**, **runner pods hold no ServiceAccount token**
  (`automountServiceAccountToken: false`; pinned in `driver/test/k8s/`), and **the driver never reads a Secret back**: the Role grants no `get`/`list`.
- **Every driver-owned object carries `factory.job`**, every Secret follows `factory-job-…-env`, every
  task volume mount is whole or at the reviewer's home (`REVIEWER_TREE_DIR`), `hostAliases` map only to
  `127.0.0.1` and only the `gate`, `reviewer` and `svc-` sidecars restart — or admission refuses it. `driver/test/k8s-admission.test.ts`.
- **The agent container's env holds no GitHub token and no route to the step channel**; the claim env and the
  board's GitHub token are a step's own `env`. `driver/test/supervised-steps.test.ts`, `driver/test/github-credential.test.ts`.
- **The fence orders contenders by `claim_seq`, never by a clock or the refundable attempt counter.**
  `driver/test/k8s/` (`after its attempt was refunded`, `no claim sequence`).
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
  `driver/src/k8s/k8s-adopt.ts`, `driver/src/docker/docker-close-read.ts`.
- A taken-over run's agent and exporter reach the new holder through the supervisor's relay (`serveRelay`); a
  request in flight across the rebind is hung up on (the exporter retries it; the agent's proxy answers 502), and
  the transcript continues under the new claim from its first unacknowledged byte.
  `driver/test/supervisor.test.ts`, `driver/test/control-proxy.test.ts`.
- Stated limit: a taken-over run's agent gate requests (`BELLOWS_GATE_*`) keep the lost driver's endpoint; the
  end-of-run gates run on the new holder (follow-up #909). `driver/src/loop/loop-gates.ts`.
- Stated limit: a driver cut off from the board but still reachable by its supervisor never learns its lease was
  lost (`beat()` swallows failed heartbeats), so it keeps contact past the adopter's finalize wait; the adopter
  then sweeps and redoes the run (kubernetes) or is blocked until the supervisor ends (docker).
  `driver/src/loop/loop-attempt.ts`.
- Stated limit: a rebind reaches a live supervisor only once the kubelet refreshes the attempt Secret's volume —
  up to its sync period (default one minute) plus its cache delay; docker's write is seen on the supervisor's next
  control poll. `driver/src/k8s/k8s-binding.ts`.
- Stated limit: a node going NotReady is seen only when the cluster acts on it (taint-based eviction, default ~300 s, then the Job's `FailureTarget`/`Failed` or the pod's deletion); the driver never treats stale pod status as loss. `driver/src/group-watch.ts`.
- Stated limit: a takeover needs `driver.rebindGraceMs` to outlast that refresh (~60 s measured); a shorter grace ends
  the group before the new holder's binding arrives. `charts/factory/values.yaml`, `scripts/test-k8s.sh`.
- Stated limit: why a driver ended a run is recorded on the attempt only where it outlives the kill — a hard-kill
  deletes the Job, its record, its Secrets and its claim before `end` reaches the board, a refused record is
  none — and such a run is redone in its tree and session. `driver/src/termination.ts`, `driver/src/k8s/k8s-runner.ts` (`killRunner`).
- Stated limit: a verdict neither staged nor completed within one lease leaves its group and checkout claim to the
  next claim: its agent outcome is adopted and resumes after the last post-run phase checkpointed on the board (`gates`
  bound to the tree's fingerprint, then `post`, `publish`); a phase whose checkpoint is missing, unreadable or bound to
  another tree runs again, with every phase after it, and an attempt with no budget left can retire `dead` before it is
  adopted. `driver/src/loop/loop-conclusion.ts` (`end`), `driver/src/loop/loop-phase-checkpoints.ts`.
- Stated limit: a declared service image needs `sh`, `cat` and a writable `/tmp` — its liveness probe
  (`driver/src/scripts/service-generation-probe.sh`) fails on every run without them.
- Stated limit: the kubernetes question round trip (a real claude CLI through the bridge)
  is not run on a kind cluster — the cluster lane installs the stub executor image. The relay is pinned offline in
  `driver/test/k8s/` and run through the supervisor with the stub's question (`--phase control`); docker's lane is `ask_roundtrip_lane` in `scripts/test-jobs.sh`.
- `make reset` destroys the local state release and its data; the `volumeClaimTemplate` claim survives `helm uninstall`.
  `EXECUTOR=kubernetes` with `RUNNER_CACHE_WATCH=1` is fatal at startup (`driver/src/config.ts`).
- Deliberate docker divergences: no cpu-request flag, no node scheduling, no `imagePullSecrets` twin, no admission
  equivalent; on docker (development only) service listeners are reachable by IP on the compose network (`driver/src/docker/docker-mailbox.ts`).

## EKS prerequisites

Each is silent when wrong. Walk: [eks-runbook.md](eks-runbook.md); measured claims: [limits.md](limits.md).

- **Node-level IMDS defence** — `httpPutResponseHopLimit: 1` on the runner node group.
- **The VPC CNI add-on needs `enableNetworkPolicy: true`**, enforcing only on EC2 Linux nodes — not Fargate, not
  Windows. Without it the NetworkPolicy is admitted and inert.
- **Every runner pod is a Job's** — the driver creates no bare pod — closing AWS's standalone-pod caveat
  (`charts/factory/templates/driver-rbac.yaml`).
- **metrics-server is not installed by default** (vitals read null), and **`blockedCidrs` blocks the VPC too** — a
  runner that must reach a VPC endpoint needs that host in `isolation.allowedCidrs` as a /32.
- **The task volume** needs the EBS CSI driver add-on running and a StorageClass with `provisioner: ebs.csi.aws.com`,
  `volumeBindingMode: WaitForFirstConsumer`, `type: gp3`, `reclaimPolicy: Delete`, named by `taskVolume.storageClass`
  (the default `''` fits kind, nothing on EKS); the operator creates it ([eks-runbook.md](eks-runbook.md)). **Only the
  driver's task pods set `fsGroup`** (`core/test/docs.eks-storage.test.ts`), which makes the block volume writable by
  uid 1000. Stated limit: `ReadWriteOncePod` on the EBS CSI driver and the chart on EKS have never been observed.

## Isolation: assumptions and residuals

Controls and why none of this is kernel or VM isolation: [security.md](security.md). The deployment must provide
**A CNI that enforces NetworkPolicy**, **ValidatingAdmissionPolicy, native sidecars and `pods/resize`, Kubernetes ≥ 1.33**,
the IMDS defence. Residuals:

- **IPv6 egress is not covered**; every rule is IPv4.
- A runner can **reach the driver pod on any port** (the gate endpoint has an ephemeral port). Runner pods take no
  ingress, so one attempt cannot reach another (`--netpol` pins it denied); a declared service name resolves to
  `127.0.0.1` through `hostAliases`, never through DNS (#296).
- An apiserver or node address that is **PUBLIC is not covered** by `blockedCidrs`. A NetworkPolicy also
  **says nothing about HTTP routes**.
- A thread's disk is its `taskVolume.size` request, a cap only where the provisioner enforces it; `REVIEWER_UID` separates signals, not files.
