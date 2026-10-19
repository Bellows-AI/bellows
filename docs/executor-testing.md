# Executor testing

Which lane proves what for the board/driver/runner/telemetry control plane, listed by boundary, not by coverage.

| Lane | Needs | Proves |
| --- | --- | --- |
| `npm run test:executors` | nothing | Board routes, orchestration, both runners, image/config artifacts, OTLP parsing — offline. Config in `vitest.executors.config.ts`. |
| `npm run test:coverage:executors` | nothing | The same surface against the thresholds in that config. |
| `DATABASE_URL=…/factory_test npm run test:db` | postgres | Real lease, fencing, attribution, deduplication and rollup SQL (`vitest.db.config.ts`), and the CLI scripting flow over real board HTTP and SQL with no driver or runner (`server/test-db/cli.scripting.test.ts`). |
| `npm run test:jobs` | docker, port 8129 | Real board HTTP, a real driver, real containers, a disposable database (`scripts/test-jobs.sh`); every task runs against a ready fixture repository whose origin is a bare repo in the driver volume (`server/test/test-jobs.harness.test.ts`), and every stub runner, here and in `npm run test:k8s -- --cluster`, honors the supervisor's agent contract through `scripts/stub-agent.sh` (`driver/test/lane-stubs.test.ts`). Its node-disruption phase kills (`kill -9`) and drains (`DRIVER_HANDOVER_MS`) a driver mid-run: the next claim adopts the finished runner, one attempt and one interruption, the kill at `max_attempts` 1; a driver lost together with its runner is redone by a replacement runner in the lost session on the restored tree. Its stubs run no executor image, so the live opencode session and both resume fallbacks are proven offline only (`driver/test/claude-bridge.test.ts`, `executor-images.test.ts`, `server/test/routes.ingest.test.ts`). Required before changing docker runner behavior. |
| Phase selection and timings | `npm run test:jobs -- --phase <name>` (`--help` lists names) | All phases by default; selected phases provision fixtures without running other phases. Each run owns its image tags, database, volumes and compose project; `PORT` selects the loopback port base (default 8129). Standalone CLI phases need no board or build; real executor images are checked before setup. Phase totals (including cleanup), intervals between checks and process logs: `artifacts/jobs/<run>.tsv` and sibling files (`TIMINGS_FILE` overrides). Routing, preflight and failure artifacts: `scripts/test-jobs.sh`, `server/test/test-jobs.options.test.ts`. |
| the cooperative-Stop and tool-isolation phases of `npm run test:jobs` | docker, `make runners` | The real `claude` and `opencode` in the executor images against `scripts/fake-model-endpoint.mjs` (offline, no credential): a Stop raised inside the first model step ends the run after that step's tool call and before a second model request; under the driver's agent flags, tools that `kill -TERM 1; kill -KILL -1` leave the CLI to finish, while the same run without the flags dies (the honest control); a driver-run stub whose tool does the same succeeds in one attempt. The endpoint's own protocol and the lanes' flags are pinned in `driver/test/fake-model-endpoint.test.ts`; the in-image half is `docker/tool-isolation-checks.sh`, sourced by each image's `test.sh`. |
| the question round-trip phase of `npm run test:jobs` | docker, `make runners` | Board + driver + the real `claude-executor` against the endpoint's `--ask` mode: the job shows a pending question, a member's answer settles it `succeeded` with `ANSWER=Blue`, a second answer is 409 `QUESTION_ANSWERED`; a Stop while pending settles `stopped` and the question reads `closed`. Kubernetes has no such lane — a stated limit in [kubernetes.md](kubernetes.md). |
| `npm run test:k8s` | helm | `helm lint`/`helm template` assertions in both the local and the EKS value shapes, including the rendered CEL and the port-scoped egress rules. Required before changing Kubernetes runner behavior. |
| `npm run test:k8s -- --cluster` | a cluster from `make cluster` (kind plus its local registry), kubectl, docker | A real apiserver compiles the admission policy and refuses a pod missing each field in turn; a queued job comes back succeeded; the workspace boundary is probed from inside a pod; a driver pod force-deleted or drained mid-run and a runner pod deleted mid-run each end succeeded with one attempt and one interruption — the finished runner Job adopted, never reaped unread, the force-delete at `max_attempts` 1 — and a driver pod and its runner Job deleted together end succeeded in the lost session on the restored tree; a stub whose tool signals everything it may succeeds in one attempt, and the policy admits the agent launch pair on a runner Job's `agent` alone. `scripts/test-k8s.sh`: all phases by default; `--phase smoke\|admission\|workspace\|recovery` selects smoke prerequisites plus that phase. Timings including cleanup: `artifacts/k8s/<release>.tsv` (`TIMINGS_FILE` overrides), with `.checks.tsv` (seconds per check), `.pods.tsv` (each pod's schedule, pull and start, from events: `scripts/k8s-pod-timeline.mjs`), `.driver-smoke.log` and `.runner-smoke.log` (timestamped container logs) beside it. `scripts/k8s-stub.sh` releases recovery agents through workspace barriers (`driver/test/lane-stubs.test.ts`, `driver/test/k8s-lane.test.ts`). The rebuilt images go to the cluster's registry under a per-run tag, refused without it by `scripts/kind-cluster.sh check` (`driver/test/k8s-lane.test.ts`). |
| `npm run test:k8s -- --netpol` | kind, kubectl, docker, network | The network denials, on a cluster this lane creates with kindnet disabled and Calico installed. |
| `npx vitest run driver/test/k8s-admission.test.ts` | nothing | The policy requires the hardening **and** the driver's own output satisfies what it requires — the half that keeps a tightened policy from becoming a cluster-wide outage. |

## Invariants

- **A "denied" assertion run against a CNI that does not enforce NetworkPolicy passes
  vacuously** — it reports success while proving nothing. That is why `--netpol` owns its own
  Calico cluster instead of borrowing the `--cluster` one, and why it runs an **honest-probe
  control on every denial target**: each target must answer `reachable` before the policy and
  `denied` after, so a target nothing listens on fails the lane loudly.
- **Platform-parity cases are not duplicates.** When a contract is encoded in both docker argv and
  Kubernetes object specs, both pins stay. Consolidate only when setup, branch and expected failure
  are identical.
- **The focused coverage gate excludes `driver/src/index.ts`, `driver/src/scripts/` and the
  Postgres telemetry store** (`vitest.executors.config.ts`); the script suites and `test:db` cover them.
- **A new slow boundary test must close a missing boundary, not repeat a covered branch.** Build
  large git histories with `git fast-import` rather than real commits.

## What no lane covers

- **`npm run test:jobs` on a Linux docker daemon.** The compose-driver and question-round-trip phases
  reach the open board and the driver's control server through `host.docker.internal`, which only
  Docker Desktop forwards to the host's loopback, and `AUTH_MODE=none` refuses any other bind
  (`assertNoneModeBindable`, `server/src/config.ts`) — so those 9 checks of `scripts/test-jobs.sh`
  need host networking there, and the lane is not in CI ([ci.md](ci.md)).
- **The real collector** is in neither end-to-end path; `test:jobs` and `--cluster` assert the
  driver's export, not a stored-and-rolled-up datapoint.
- **A cloud cluster.** `--cluster` refuses every non-kind context deliberately (it deletes runner
  Jobs), so the EKS value shape is only rendered offline and walked by hand
  ([eks-runbook.md](eks-runbook.md)).
- **Fault injection in the kind phase** beyond the node-disruption section of `scripts/test-k8s.sh`
  — not API outage, stop-during-sync or a failed cleanup.
- **A real agent CLI honouring the master prompt's flags.** Both transports' argv is pinned
  offline; nothing proves the vendor binaries accept them. That needs a model credential. (The
  scripted endpoint above proves the Stop boundary only — not model quality or the prompt's flags.)
- **Allowlisted block helpers under `--cluster`** — only the bare echo-executor happy path. Both
  real blocks need a "GitHub" to talk to, and no agreed way to fake one inside kind.
- **The cloud metadata endpoint (169.254.169.254) is not probed.** Nothing answers on it in kind,
  so the probe could only ever report `denied` — the vacuous pass this file exists to prevent.
  What the lane does prove is the mechanism underneath: `169.254.0.0/16` is a `blockedCidrs` entry
  excluded from the same `0.0.0.0/0` egress rule the node probe shows dropping traffic for real.
  The endpoint's own defence is a node setting outside the chart ([kubernetes.md](kubernetes.md)).
- **IPv6, cross-attempt isolation, DNS shadowing** — residuals in [kubernetes.md](kubernetes.md).
  **Task-level workspace isolation** does not exist — the mount is a member boundary
  ([workspace.md](workspace.md)). **Kernel isolation** is claimed nowhere
  ([security.md](security.md)).
