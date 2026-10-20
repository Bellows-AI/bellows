# Kubernetes

The primary executor — runners are Jobs the driver reconciles itself, no CRD — and the chart deploying it.

## Where things live

| Concern | Code | Test |
| --- | --- | --- |
| The `Runner` seam both executors implement | `driver/src/runner.ts`, `driver/src/k8s-runner.ts` | `driver/test/k8s.test.ts` |
| Executor-neutral state: paths, claim env, outcome parsing, container scripts, argv plan | `driver/src/claim.ts`, `close-read.ts`, `container-scripts.ts`, `runner-plan.ts` | `driver/test/scripts.test.ts`, `runner-plan.test.ts`, `close-read.test.ts` |
| Wire types, the transport (a pod log past its stream buffer is answered as its tail, flagged `truncated`; every other answer is read whole), protocol constants and status thresholds | `driver/src/k8s-transport.ts` | `driver/test/k8s-transport.test.ts` |
| Job specs: runner, readouts (the opencode readout also exports its session; no `.bellows.yaml` readout exists, the claim carries the plan), the runner pod's three containers (supervisor, agent, claude transcript exporter), its `gate` and `svc-<name>` native sidecars and its `emptyDir` mailboxes, per-attempt Secret names, resource and scheduling fields | `driver/src/k8s-podspec.ts`, `k8s-auxspec.ts`, `k8s-podfields.ts` | `driver/test/k8s.test.ts` |
| The task group: one Job per attempt, created by its first step (the sync) and ended by the loop's `finish`, not by the agent's exit; the agent container waits on `in/agent/go`; a thread with no attempt reclaims in a supervisor-only group | `driver/src/k8s-group.ts`, `k8s-runner.ts`, `k8s-podspec.ts` | `driver/test/k8s-group.test.ts`, `driver/test/k8s.test.ts` |
| The re-claim fence, the polling it brackets, what a Stop mid-run leaves, and a runner Job deleted under its run (an infrastructure loss, `RunnerVanished`) | `driver/src/k8s-fence.ts`, `k8s-poll.ts`, `k8s-kill.ts` | `driver/test/k8s.test.ts` |
| The cooperative Stop and draft publication: the supervisor's `SUPERVISOR_CONTROL_*` rides the per-attempt Secret into the supervisor container only and polls the driver pod's IP; the agent's publish/review `BELLOWS_CONTROL_*` reaches its control proxy alone, never a tool, the exporter's export-only `SUPERVISOR_EXPORT_TOKEN` reaches the exporter alone, and the supervisor has no ServiceAccount token | `driver/src/k8s-podspec.ts`, `loop-gates.ts`, `loop-publish.ts` | `driver/test/k8s.test.ts`, `driver/test/publish-control.test.ts` |
| Gates in the runner pod's `gate` native sidecar, each a supervised step, resized in place (`pods/resize`, a strategic merge patch naming `gate` alone) idle before `go` and to the gate requests for verify; declared services (the claim's `services`, never a file read) as `svc-<name>` native sidecars named on the pod's loopback (`hostAliases`), restarted fleet-wide by a generation bump their liveness probe reads, dead when exited or restarted by the kubelet | `driver/src/k8s-gate.ts`, `k8s-podspec.ts`, `k8s-services.ts`, `scripts/service-generation-*.sh`, `charts/factory/templates/driver-rbac.yaml`, `driver-admission.yaml` | `driver/test/k8s.test.ts`, `scripts/test-k8s.sh` |
| Gate sizing: `GATE_*` (chart `runner.gateResources`) over `RUNNER_*`, slot by slot — limits from the start, requests the idle figures (never above those) until verify; the docker gate container renders the same | `driver/src/config.ts`, `k8s-podfields.ts` (`gateRequests`), `docker-group.ts` (`gateCreateArgs`) | `driver/test/k8s.test.ts`, `driver/test/docker-group.test.ts`, `scripts/test-k8s.sh` |
| A claim listing `reviewerProfiles` adds one dormant `reviewer` native sidecar (executor image, `REVIEWER_UID` 1002, idle-low and resized in place by `resizeReviewer`): the member subtree read-only, the review mailbox it shares with the supervisor alone, a read-write home (the member tree's `.factory/reviewer`, made group-writable by `ensureReviewerHome` at the claim and at sign-in); the model credentials the agent reads and no publish token, credential helper or other Secret ref; admission admits it as the one other restartable name and refuses another uid or mount | `driver/src/k8s-podspec.ts` (`reviewerSidecar`), `k8s-gate.ts`, `k8s-podfields.ts` (`reviewerRequests`), `scripts/review-loop.sh`, `charts/factory/templates/driver-admission.yaml` | `driver/test/k8s.test.ts`, `driver/test/k8s-admission.test.ts`, `driver/test/scripts-review-loop.test.ts` |
| Supervised steps: the sync, tree probe, review snapshot, publish steps and allowlisted helpers are requests the supervisor pulls (`GET /step`) and runs in its own container, never a Job or container of their own; credentials ride the step, not a spec; a Job that ends with no report taken, or a kill, fails the steps still waiting at once | `driver/src/supervised-steps.ts`, `step-control.ts`, `control-channel.ts`, `scripts/supervisor.cjs` | `driver/test/supervised-steps.test.ts`, `driver/test/step-control.test.ts`, `driver/test/supervisor.test.ts` |
| Publish, revision-bound evidence and agent-opened PRs run as the same supervised steps over both executors; a persisted operation (`<branch>@<sha>` in the worktree's `.factory/`) and a remote read after any uncertain answer keep a retried publish from pushing or opening twice | `driver/src/publish.ts`, `publish-reconcile.ts`, `evidence-policy.ts`, `loop-verdict.ts`, `docker/claude-executor/git-guard.cjs` | `driver/test/publish-checkout.test.ts`, `driver/test/publish-hooks.test.ts`, `driver/test/publish-reconcile.test.ts`, `driver/test/k8s.test.ts`, `driver/test/docker.test.ts` |
| Failure cause (`verification`/`conflict`/`denied`/`config`/`transport`/`environment`/`unknown`) classified once over both executors: a publish step's own log, a lost step answer, a gate's exit, vitest worker timeouts and stale file handles; a refused group start (`StartupRefused`: transient/image/auth/config) from a held container's waiting reason and words, and from the daemon's stderr, with a pod still coming up at `GROUP_UP_WAIT_MS` transient | `driver/src/publish.ts` (`publishCauseOf`), `gate-cause.ts`, `loop-ledger.ts` (`causeOf`), `startup-cause.ts`, `k8s-poll.ts` (`startRefusalOf`), `k8s-group.ts`, `k8s-runner.ts`, `docker-runner.ts` | `driver/test/k8s.test.ts`, `driver/test/docker.test.ts`, `driver/test/publish-cause.test.ts`, `driver/test/gate-cause.test.ts`, `driver/test/startup-cause.test.ts` |
| A named reviewer runs in the caller's pod, supervised by the caller's driver as `review` steps (home, `RESTORE=1` sync, the executor in the reviewer container, a close-time transcript export run by that container, its worktree under the caller's `<task tree>.reviews/` that the caller's reclaim removes) under the review row's own lease, with no Job, Secret or reclaim of its own; a lost pod's re-claim re-asks the key and resumes the recorded session | `driver/src/review-step.ts`, `loop-review.ts` (`superviseReview`), `review-snapshot.ts`, `driver/src/scripts/supervisor.cjs` | `driver/test/review-step.test.ts`, `driver/test/loop-review.test.ts`, `driver/test/supervisor.test.ts`, `driver/test/k8s.test.ts` (`a full attempt`) |
| Same image, same argv: the Jira connector's `JIRA_API`, the AskUserQuestion bridge, selected skills | `docker/claude-executor/entrypoint.sh`, `claude-bridge.cjs`, `driver/src/loop-run.ts` | `driver/test/executor-images.test.ts`, `driver/test/claude-bridge.test.ts` |
| Question wait pauses: remove the runner Job's `activeDeadlineSeconds`, restore it after answers (`patch` on `jobs`) | `driver/src/k8s-runner.ts`, `k8s-transport.ts`, `charts/factory/templates/driver-rbac.yaml` | `driver/test/k8s.test.ts`, `scripts/test-k8s.sh` |
| Orphan Jobs (including paused runners) and attempt Secrets; a finished runner Job (marked `factory.claim-seq`/`factory.session`, and `factory.kill.<reason>` when its driver ended it for a verdict of its own) is adopted by the next claim, never reaped unread, one whose agent exited while its supervisor finalizes is waited out under the claim first, and the supervisor's logged final report (`finalReportOf`) is read as its finalization; a lost supervisor leaves the attempt interrupted for that claim, never failed | `driver/src/reaper.ts`, `driver/src/k8s-reaper.ts`, `driver/src/k8s-adopt.ts` | `driver/test/k8s-reaper.test.ts`, `driver/test/k8s.test.ts`, `scripts/test-k8s.sh` |
| Ending and creating runner Jobs (kill, `finish`, a failed sync, a stand-down, a reclaim group, the fence's sweep): a Job is created suspended, its Secret after it (owned by the Job's uid) and resumed after the post-create verify; one `TeardownIdentity` recorded as each create answers names every resume, suspend and delete by uid, retries included; Secrets are deleted, each answer read, before the Job, and a refused one suspends the Job instead; `ended` comes only from the live (non-`Succeeded`/`Failed`) writer-pod confirmation, and only then is the checkout claim released or deleted (`releaseClaimAfterGroupEnd`), a teardown pending from its first synchronous step; a Job that ran an agent and ended by itself on `finish` is kept for adoption (never a supervisor-only group's), spared only by the sweeps of the claim that adopted it; a reclaim group runs under a random lease of its own labelled with the holder it serves (`factory.holder`), found again by that label and waited out while any of it writes; the sweep and the reaper delete each listed object by its listed uid, the reaper never a live job's runner Job nor a claim held by anyone but the condemned attempt or a reclaim it served; an adoption whose sweep cannot confirm a leftover gone, that cannot read whether an earlier agent ended or a finalizing Job to its end, or whose claim was taken over meanwhile leaves the attempt to its lease (`AdoptionBlocked`) | `driver/src/k8s-teardown.ts`, `k8s-fence.ts`, `k8s-group.ts`, `k8s-runner.ts`, `k8s-adopt.ts`, `k8s-reaper.ts` | `driver/test/k8s.test.ts`, `driver/test/k8s-reaper.test.ts`, `driver/test/k8s-group.test.ts` |
| Reclaim ownership: each acquisition of a reclaim row holds the checkout claim under its own token, so a later acquisition stands down on an earlier one's claim; an orphaned-claim reap first revokes the claim it read (`factory.revoked`, a uid-preconditioned `patch` on `configmaps`), then lists and ends the holder's groups, and a reclaim group whose claim reads revoked at its post-create verify never starts | `driver/src/k8s-runner.ts` (`reclaimWorktree`, `reapOrphanedClaim`), `driver/src/k8s-fence.ts` (`revokeClaim`), `driver/src/k8s-group.ts` (`reclaimInGroup`), `driver/src/loop-reclaim.ts`, `charts/factory/templates/driver-rbac.yaml` | `driver/test/k8s.test.ts`, `scripts/test-k8s.sh` |
| Every `EXECUTOR`, `K8S_*`, `RUNNER_*` and `GATE_*` variable, with its boot-time validation | `driver/src/config.ts` | `driver/test/config.test.ts` |
| The app chart: dashboard, driver, collector, RBAC, PDBs, Ingress, `LimitRange` | `charts/factory/` ([README](../charts/factory/README.md)) | `scripts/test-k8s.sh` |
| The admission policies that fence the driver, admitting one capability add: `SETUID`/`SETGID` on a runner Job's `agent`; and one update: a checkout claim's revoke (`factory-job-<id>-claim` only, labels and data kept, no annotation but `factory.revoked` changed) | `charts/factory/templates/driver-admission.yaml`, `driver/src/k8s-podfields.ts` | `driver/test/k8s-admission.test.ts`, `scripts/test-k8s.sh`, `scripts/test-k8s.sh --cluster` |
| Runner network confinement | `charts/factory/templates/runner-networkpolicy.yaml` | `scripts/test-k8s.sh --netpol` |
| Local Postgres, the workspaces claim, the `.env`-fed local values, `make start`/`reset`; the kind cluster and its local registry, `make cluster`/`cleanup` | `charts/factory-local-state/`, `scripts/k8s-local-values.mjs`, `scripts/kind-cluster.sh`, `scripts/kind-cluster.yaml`, `Makefile` | `scripts/test-k8s.sh`, `driver/test/k8s-lane.test.ts`, `core/test/makefile.kind-cluster.test.ts` |

## Invariants

- **Executor parity** (AGENTS.md): a `k8s-*.ts` importing from `docker*.ts` means the shared name belongs in a
  neutral file.
- **Credentials go by reference, never by value**, and **runner pods hold no ServiceAccount token**
  (`automountServiceAccountToken: false`). Both pinned in `driver/test/k8s.test.ts`.
- **Every driver-owned object carries `factory.job`**, every Secret follows `factory-job-…-env`, every
  workspaces mount uses `workspaceMount()`'s `<org>/<user id>` subPath, `hostAliases` map only to `127.0.0.1` and
  only the `gate` and `svc-` sidecars restart — or admission refuses it. `driver/test/k8s-admission.test.ts`.
- **The agent container's env holds no GitHub token and no route to the step channel**; the claim env and the
  board's GitHub token are a step's own `env`, and the agent's helper caches its own in a Memory `emptyDir`.
  `driver/test/supervised-steps.test.ts`, `driver/test/github-credential.test.ts`.
- **The fence orders contenders by `claim_seq`, never by a clock or the refundable attempt counter.**
  `driver/test/k8s.test.ts` (`after its attempt was refunded`, `no claim sequence`).
- **A runner group whose driver is lost ends inside its lease** (`orphanBoundMs`, `driver/src/supervisor-plan.ts`;
  30 s floor under a 120 s lease) and is adopted; lost before `go`, its supervisor exits `SUPERVISOR_EXIT.lost` and
  the run is redone, never adopted. `driver/test/supervisor.test.ts`, `driver/test/scripts-claude-export.test.ts`,
  `driver/test/k8s.test.ts`.
- **The driver never reads a Secret back** — the Role grants no `get`/`list`; attempt Secrets are reaped by
  derived name.
- **`make start` refuses a state claim initialised without `PGDATA`** and a pre-StatefulSet state release; both name
  `make reset`. `core/test/makefile.state-preflight.test.ts`.
- Stated limit: a runner still RUNNING when its driver is lost is swept by the next claim's re-claim fence and
  the job redone in its session and tree, an interruption inside the budget; one whose agent exited is waited
  out (`SUPERVISOR_WINDDOWN_MS`) and adopted with its logged report, and a lost driver still alive steps into it
  until its lease or the group's orphan bound ends, the wait outlasting both. A finished one is adoptable until
  its Job's one-hour `ttlSecondsAfterFinished`. `driver/src/k8s-adopt.ts`, `driver/src/docker-close-read.ts`.
- Stated limit: why a driver ended a run is recorded on the attempt only where it outlives the kill — a hard-kill
  fallback deletes the Job and its record, a refused record is none — and such a run is redone in its tree and
  session. `driver/src/termination.ts`, `driver/src/k8s-adopt.ts`, `driver/src/docker-close-read.ts`.
- Stated limit: a verdict neither staged nor completed within one lease leaves its group and checkout claim to the
  next claim: its agent outcome is adopted, but the gates and the post-processing run again, and an attempt with no
  budget left can retire `dead` before it is adopted. `driver/src/loop-fence.ts` (`concludeAttempt`).
- Stated limit: a thread with no attempt reclaims in a supervisor-only group (one Job, no agent; the tool uid's
  `release` init container first), because nothing else holds the task volume; its pod requests are held while
  the gates run. `driver/src/k8s-group.ts` (`reclaimInGroup`, `reclaimGroupSpec`).
- Stated limit: a declared service image needs `sh`, `cat` and a writable `/tmp` — its liveness probe
  (`driver/src/scripts/service-generation-probe.sh`) fails on every run without them.
- Stated limit: the kubernetes question round trip (a real claude CLI through the bridge)
  is not run on a kind cluster — the cluster lane installs the stub executor image. The relay is pinned offline in
  `driver/test/k8s.test.ts` and run through the supervisor with the stub's question (`--phase control`); docker's lane is `ask_roundtrip_lane` in `scripts/test-jobs.sh`.

## Operational facts

- `make reset` destroys the local state release and its data; the `volumeClaimTemplate` claim survives
  `helm uninstall`.
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

### The workspaces volume

The chart defaults (`ReadWriteMany`, `storageClass: ''`) fit kind and nothing on EKS. It needs:

1. **The EFS CSI driver, running** — controller bound to an IAM role by IRSA or EKS Pod Identity. Check the
   controller pods, **never for the `CSIDriver` object**.
2. **A mount target in every availability zone the nodes run in.**
3. **A StorageClass owned by uid 1000** — `provisioningMode: efs-ap`, `directoryPerms: "0775"`, `uid: "1000"`,
   `gid: "1000"`; then `workspaces.storageClass`.

**No pod spec sets `fsGroup`** (`core/test/docs.eks-storage.test.ts`); on an RWX NFS mount
the access point's POSIX user is what makes the tree writable. Dynamic provisioning always applies
identity enforcement, and a class omitting `uid`/`gid` draws from the driver's allocation range.

That contract was **observed on a real EKS cluster** — eu-central-1, v1.34, **2026-09-30**:
`Uid 1000` / `Permissions 0775`, a cross-zone `subPath` mount over `nfs4`. The chart itself
has **never been installed on EKS**. The single-AZ `ReadWriteOnce` fallback needs
`runner.nodeSelector`/`tolerations`/`affinity`; without them a driver-specced pod has no scheduling knob
(admission refuses `nodeName`).

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
- **No per-task or per-org disk cap** on the workspaces volume; one run can fill it for everyone.
- **The reviewer's files are on the shared volume, and it costs a floor.** Its worktree lives inside the member subtree, which the agent mounts too, and on EKS the EFS access point forces uid 1000, so `REVIEWER_UID` separates signals, not files. A fresh opencode review records its session id only when the run ends (as the caller's own run does), so a pod lost mid-review cannot resume it and restarts from the snapshot. An idle reviewer holds its floor (`reviewerRequests`, 50m CPU / 64Mi, read back off a live kind pod by `scripts/test-k8s.sh`; kind has no metrics API, so usage is unmeasured) for the pod's whole life.
- Same-member tasks share a workspace subtree ([workspace.md](workspace.md)). A runner pod gone before the verdict
  read uploads no log, and a log the kubelet rotated (`containerLogMaxSize`) uploads its newest file only, unflagged.
