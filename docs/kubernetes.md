# Kubernetes

The primary executor — runners are Jobs reconciled by the driver itself (no CRD, no second control loop) — plus the
Helm chart that deploys the whole factory.

## Where things live

| Concern | Code | Test |
| --- | --- | --- |
| The `Runner` seam both executors implement | `driver/src/runner.ts`, `driver/src/k8s-runner.ts` | `driver/test/k8s.test.ts` |
| Executor-neutral state: paths, claim env, outcome parsing, container scripts, argv plan | `driver/src/claim.ts`, `close-read.ts`, `container-scripts.ts`, `runner-plan.ts` | `driver/test/scripts.test.ts`, `runner-plan.test.ts`, `close-read.test.ts` |
| Wire types, the transport, protocol constants and status thresholds | `driver/src/k8s-transport.ts` | `driver/test/k8s-transport.test.ts` |
| Job specs: runner, gates, readouts, transcript, sync/reclaim/publish/service, per-attempt Secret names, resource and scheduling fields | `driver/src/k8s-podspec.ts`, `k8s-auxspec.ts`, `k8s-podfields.ts` | `driver/test/k8s.test.ts` |
| The re-claim fence, the polling it brackets, and what a Stop mid-run leaves | `driver/src/k8s-fence.ts`, `k8s-poll.ts`, `k8s-kill.ts` | `driver/test/k8s.test.ts` |
| The cooperative Stop and draft publication: `BELLOWS_CONTROL_*` rides the per-attempt Secret; the runner polls the driver pod's IP | `driver/src/k8s-podspec.ts`, `loop-gates.ts`, `loop-publish.ts` | `driver/test/k8s.test.ts`, `driver/test/publish-control.test.ts` |
| Gates as Jobs, a gate's `timeout:` its Job's `activeDeadlineSeconds`; declared services as owned pods under the attempt's headless Service, started before the setup Job and spared by the runner's sweep (`factory.lease!=`); a vanished pod's newest event | `driver/src/k8s-gates.ts`, `k8s-services.ts`, `charts/factory/templates/driver-rbac.yaml` | `driver/test/k8s.test.ts`, `scripts/test-k8s.sh` |
| Gate pod sizing: `GATE_*` (chart `runner.gateResources`) over `RUNNER_*`, slot by slot; the docker gate container renders the same | `driver/src/config.ts`, `k8s-podspec.ts` (`gateJobSpec`), `docker.ts` (`gateEnvArgs`) | `driver/test/k8s.test.ts`, `driver/test/docker.test.ts`, `scripts/test-k8s.sh` |
| Block helpers as aux Jobs | `driver/src/k8s-helper-runner.ts` | `driver/test/k8s.test.ts` |
| Publish, revision-bound evidence and agent-opened PRs run as the same aux Jobs over both executors | `driver/src/publish.ts`, `evidence-policy.ts`, `loop-verdict.ts`, `docker/claude-executor/git-guard.cjs` | `driver/test/publish-checkout.test.ts`, `driver/test/k8s.test.ts`, `driver/test/docker.test.ts` |
| Failure cause (`verification`/`conflict`/`denied`/`config`/`transport`/`environment`/`unknown`) classified once over both executors: a publish step's own log, the publish Secret's refusal, a gate's exit, vitest worker timeouts and stale file handles | `driver/src/publish.ts` (`publishCauseOf`), `gate-cause.ts`, `loop-ledger.ts` (`causeOf`), `k8s-runner.ts`, `docker-runner.ts` | `driver/test/k8s.test.ts`, `driver/test/docker.test.ts`, `driver/test/publish-cause.test.ts`, `driver/test/gate-cause.test.ts` |
| A named reviewer: snapshot aux Job, a `RESTORE=1` sync Job, `activeDeadlineSeconds` capped by `DRIVER_JOB_TIMEOUT_MS` | `driver/src/k8s-steps.ts`, `review-snapshot.ts`, `k8s-auxspec.ts` | `driver/test/review-executors.test.ts`, `driver/test/review-snapshot.test.ts` |
| Same image, same argv: the Jira connector's `JIRA_API`, the AskUserQuestion bridge, selected skills | `docker/claude-executor/entrypoint.sh`, `claude-bridge.cjs`, `driver/src/loop-run.ts` | `driver/test/executor-images.test.ts`, `driver/test/claude-bridge.test.ts` |
| Question wait pauses: remove the runner Job's `activeDeadlineSeconds`, restore it after answers (`patch` on `jobs`) | `driver/src/k8s-runner.ts`, `k8s-transport.ts`, `charts/factory/templates/driver-rbac.yaml` | `driver/test/k8s.test.ts`, `scripts/test-k8s.sh` |
| Orphan Jobs (including paused runners), service resources and attempt Secrets | `driver/src/reaper.ts`, `driver/src/k8s-reaper.ts` | `driver/test/k8s-reaper.test.ts` |
| Every `EXECUTOR`, `K8S_*`, `RUNNER_*` and `GATE_*` variable, with its boot-time validation | `driver/src/config.ts` | `driver/test/config.test.ts` |
| The app chart: dashboard, driver, collector, RBAC, PDBs, Ingress, `LimitRange` | `charts/factory/` ([README](../charts/factory/README.md)) | `scripts/test-k8s.sh` |
| The admission policies that fence the driver | `charts/factory/templates/driver-admission.yaml` | `driver/test/k8s-admission.test.ts` |
| Runner network confinement | `charts/factory/templates/runner-networkpolicy.yaml` | `scripts/test-k8s.sh --netpol` |
| Local Postgres, the workspaces claim, the `.env`-fed local values, `make start`/`reset` | `charts/factory-local-state/`, `scripts/k8s-local-values.mjs`, `Makefile` | `scripts/test-k8s.sh` |

What a run does — sync, gates, services, publish, helpers, reclaim — is one contract over both executors
([jobs.md](jobs.md)); lanes are [executor-testing.md](executor-testing.md).

## Invariants

- **Executor parity** (AGENTS.md): a `k8s-*.ts` importing from `docker*.ts` means the shared name belongs in a
  neutral file.
- **Credentials go by reference, never by value**, and **runner pods hold no ServiceAccount token**
  (`automountServiceAccountToken: false`). Both pinned in `driver/test/k8s.test.ts`.
- **Every driver-owned object carries `factory.job`**, every Secret follows
  `factory-{job,sync,publish,helper,gate}-…-env`, every workspaces mount uses `workspaceMount()`'s
  `<org>/<user id>` subPath — or admission refuses it. `driver/test/k8s-admission.test.ts`.
- **The fence orders contenders by `claim_seq`, never by a clock or the refundable attempt counter.**
  `driver/test/k8s.test.ts` (`after its attempt was refunded`, `no claim sequence`).
- **The driver never reads a Secret back** — the Role grants no `get`/`list`; attempt Secrets are reaped by
  derived name.
- **`make start` refuses a state claim initialised without `PGDATA`** and a pre-StatefulSet state release; both name
  `make reset`. `core/test/makefile.state-preflight.test.ts`.
- Stated limit: the kubernetes question round trip (a real claude CLI through the bridge)
  is not run on a kind cluster — the cluster lane installs the stub executor image. The relay is pinned offline in
  `driver/test/k8s.test.ts`; docker's lane is `ask_roundtrip_lane` in `scripts/test-jobs.sh`.

## Operational facts

- `make reset` destroys the local state release and its data — the `volumeClaimTemplate` claim survives
  `helm uninstall`. A `timescale/timescaledb` data directory cannot be upgraded to `postgres:17`.
- `EXECUTOR=kubernetes` with `RUNNER_CACHE_WATCH=1` is fatal at startup (`driver/src/config.ts`).
- Deliberate docker divergences: no cpu-request flag, no node scheduling, no `imagePullSecrets` twin, no admission
  equivalent; the docker fence keeps its label-sweep shape.

## EKS prerequisites

Each is silent when wrong. Walk: [eks-runbook.md](eks-runbook.md); measured claims: [limits.md](limits.md).

- **Node-level IMDS defence** — `httpPutResponseHopLimit: 1` on the runner node group.
- **The VPC CNI add-on needs `enableNetworkPolicy: true`**, enforcing only on EC2 Linux nodes — not Fargate, not
  Windows. Without it the NetworkPolicy is admitted and inert.
- **Declared-service pods are owned**, closing AWS's standalone-pod caveat: `startFleet` stamps an `ownerReference`
  to the headless Service (`driver/src/k8s-services.ts`).
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

That contract was **observed on a real EKS cluster** — `internal-utils`, eu-central-1, v1.34, **2026-09-30**:
`Uid 1000` / `Permissions 0775`, a cross-zone `subPath` mount over `nfs4`. The chart itself
has **never been installed on EKS**. The single-AZ `ReadWriteOnce` fallback needs
`runner.nodeSelector`/`tolerations`/`affinity`; without them a driver-specced pod has no scheduling knob
(admission refuses `nodeName`).

## Isolation: assumptions and residuals

Controls, and the statement that none of this is kernel or VM isolation: [security.md](security.md). The deployment
must provide **A CNI that enforces NetworkPolicy**, **ValidatingAdmissionPolicy, Kubernetes ≥ 1.30**, and the IMDS
defence above. Residuals:

- **IPv6 egress is not covered**; every rule is IPv4.
- A runner can **reach the driver pod on any port** (the gate endpoint has an ephemeral port). Cross-attempt
  isolation (#257) and declared-service DNS shadowing (#296) are owned elsewhere; `--netpol` pins the former reachable.
- An apiserver or node address that is **PUBLIC is not covered** by `blockedCidrs`. A NetworkPolicy also
  **says nothing about HTTP routes**.
- **No per-task or per-org disk cap** on the workspaces volume; one run can fill it for everyone.
- Same-member tasks share a workspace subtree ([workspace.md](workspace.md)). A runner pod gone before the verdict
  read uploads no log.
