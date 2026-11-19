# Known limits

Capabilities deliberately absent, and figures that are narrower than they look. Read before reporting a number as measured, or "fixing" anything listed here.

## What the numbers do not cover

- AI usage covers only sessions after the plugin was installed, on machines that have it, and the branch is sampled, not
  tracked — [plugins/agent-telemetry/README.md](../plugins/agent-telemetry/README.md).
- Token and line counts are what the agent wrote, not what survived: no SHA is in the attribute allowlist
  (`server/src/telemetry/otlp.ts`), so no "AI share of this diff" is possible.
- **Null is unmeasured, never zero** across the payload: the workspace checkout total stays null until every included
  checkout has a size (`server/test/routes.workspace.test.ts`).
- Seeded data is deterministic but not stable across changes to `server/src/seed/synthetic.ts`, so
  `e2e/dashboard.spec.ts` asserts structure, not figures.

## Capabilities that are absent

- `POST /api/otlp/v1/logs` accepts and discards (`server/src/routes/ingest.ts`).
- No cost (currency) allowance: the plan's spend allowance counts tokens (`server/src/db/plan-allowances.ts`).
- Telemetry needs the executor image to reach a collector — off the compose network, opencode runs go unrecorded
  ([telemetry.md](telemetry.md)).

## Known defects

- **`session_branch.branch` is nullable but sits in the primary key**, so detached-HEAD rows are rejected;
  `server/test/routes.ingest.test.ts` asserts against a stub and cannot catch it. The repair and its scope are stated at
  the key in `server/migrations/005_organizations.sql`.

## Measured versus assumed

- The EBS task volume class in [kubernetes-limits.md](kubernetes-limits.md) is unobserved: `scripts/test-k8s.sh` refuses
  every non-kind context, so no Factory release has been installed on EKS, and `ReadWriteOncePod` on the EBS CSI driver
  and a real runner write are unwatched. See [eks-runbook.md](eks-runbook.md).
- Driver loss and node drain on both executors: `scripts/test-jobs.sh --phase driver-kill` and `scripts/test-k8s.sh
  --cluster --phase takeover` kill a driver at setup, agent, gates and publish; no block declares a post-phase helper,
  so neither has a post window (`driver/test/loop-phase-checkpoints.test.ts`). Drain recovery is read from `make cluster
  CLUSTER=<n> LAYOUT=drain && npm run test:k8s -- --cluster --phase drain`, which writes
  `artifacts/k8s/<release>.recovery.tsv`: seconds from the start of `kubectl drain`, at `date +%s` resolution, on one
  laptop's kind cluster. EKS, EFS, spot notices and Karpenter are not covered; three runs are a sample, not a bound.
  Measured 2026-10-22, macOS x86_64 laptop, kind with three workers (held/settled seconds): D1 (driver node drained)
  24/33, 25/34, 24/30; D2 (runner node drained) 12/21, 9/17, 37/46 (the drain itself took 31 s). One more run failed at
  D2: the replacement runner was lost a second time and two interruptions were recorded; the cause is not established.
- Throughput and recovery are read from `npm run test:k8s -- --cluster --phase bench`, which writes
  `artifacts/k8s/<release>.bench.tsv` (workload: [executor-testing.md](executor-testing.md)). Two runs on 2026-10-23,
  macOS x86_64 laptop (8 cores, 16 GiB), one kind node: 0.8 tasks/min at 1 task, 2.8 to 3.0 (1 driver) and 3.1 to 3.2 (2
  drivers) at 4; from 8 tasks throughput holds at 3.0 to 3.4 because the node fits about five runner pods ("Insufficient
  cpu, Insufficient memory"), with no lock waiter sampled, so the board's own ceiling is not reached. A queued task
  waits for a driver's next poll, then for one claim per task ahead of it on that driver (`driver/src/loop/loop.ts`):
  claim-wait p95 was 0.9 to 5.8 s up to 4 tasks and at most 9.2 s at 16 on one driver. A killed driver's claims moved on
  at lease + 2 to 7 s and every task settled within lease + 29 s. Targets: >= 2.7 tasks/min at 4 tasks on this laptop,
  claim-wait p95 <= `driver.pollMs` + 1 s per task queued at once per driver, claim lock-wait p95 <= 25 ms, <= 1 board
  and <= 2 cluster API requests/s per active task, claims moved on <= lease + 10 s, settled <= lease + 40 s. A laptop
  sample, not a bound: EKS, EFS, Karpenter and the docker executor are unmeasured, and so is more than one dashboard
  replica. The per-thread checkout's sync step (`driver/src/supervised-steps.ts`) costs 0.35 to 1.5 s mean at 1 to 16
  concurrent threads on local-path storage, with no trend; the shared-worktree alternative is unmeasured and its code is
  gone.
- A docker class under a microVM (Kata) RuntimeClass, reported 2026-11-14 from one nested-virtualization spot node (8 vCPU) with the Docker 27 sidecar privileged, one run each: `make runners` took 86 s, `npm ci` 23 s, `kind create cluster` 38 s; the `test:jobs` phases that ran clean took 176 s (image-checks), 45 s (tool-isolation), 70 s (capacity) and 69 s (driver). Reported 2026-11-15 from the same kind of node with the smoke origin on a fixed port, one run: the full lane passed, 491 cases in 1359 s, pod memory peak about 6.2 GB (`dockerd` 2 cpu/15Gi, runner 5 cpu/11Gi), `npm ci` 25 s, `make runners` 100 s; slowest phases pinned-skills 221 s, image-checks 216 s, driver-kill 167 s ([executor-testing.md](executor-testing.md)). Reported 2026-11-19 from one probe pod (limits 4 cpu/8Gi, the dev runner image, workspace on virtiofs), one run each, n2-standard-8 vs c3-standard-8: `npm ci` 28.8 vs 22.1 s, `tsc -p server --noEmit` 11.4 vs 10.1 s, `vitest run --project server` (5464 tests) 38.6 vs 34.3 s, a single-thread node loop 23.5 vs 27.3 s. On n2, virtiofsd `--thread-pool-size=8` and `--cache=always` (pod annotation `io.katacontainers.config.hypervisor.virtio_fs_extra_args`) stayed within run-to-run noise on every step; a virtio-blk workspace cut `npm ci` to 17 s and a `node_modules` walk from 1.30 to 0.08 s, but not test or typecheck time. Reported 2026-11-19 from one probe pod on the microVM RuntimeClass (c3-standard-8, client 4 cpu/8Gi, two `postgres:17` sidecars 2 cpu/3Gi, `scripts/gate-pg-fast.sh` applied, `TEST_DB_WORKERS=8 npm run test:db`, alternating, n = 3 each): the data directory on virtiofs took 1047–1067 s wall vs a `medium: Memory` emptyDir 235–238 s; one memory run had one flaky test (a secrets-gcp conformance case). The data directory held 1.1–1.2 GiB after the runs; the guest tmpfs showed 7.9 G with `sizeLimit: 2Gi` ([kubernetes-limits.md](kubernetes-limits.md)). Samples, not bounds. Through the board on the same class, the full `test:db` gate (197 files), as the vitest duration: with the data directory on virtiofs 1421, 1463, 1517 and 1539 s (4 runs, every test passed, each gate ended on its 30-minute deadline); with a service `tmpfs`, reported 2026-11-19, 238 s (1 run, passed, `svc-postgres` memory peak 2446 MiB with its tmpfs pages, no restart). Two earlier `tmpfs` runs are not counted: one timed-out liveness probe killed the sidecar mid-gate in each (`driver/src/k8s/k8s-podspec.ts`, `SERVICE_PROBE_*`). Gate cost, reported 2026-11-19, one run each of `scripts/gate-diag.sh` on an n2-standard-8 spot node (Xeon 8481C): in a real `standard`-class gate, in a standalone pod with that gate pod's limits (24 cpu, 48 Gi summed; `scripts/gate-diag-pod.sh`) under the microVM RuntimeClass, the same pod unsandboxed on the same node shape, and a GitHub `ubuntu-latest` runner (4 vCPU). microVM / plain / GitHub: guest `nproc` 25 / 8 / 4 with a 4-cpu cgroup quota, `os.availableParallelism()` 4 / 4 / 4, so the guest does not see fewer CPUs than the pod; `npm ci` 25 / 7.6 / 10.4 s; a single-thread integer loop 0.70 / 0.068 / 0.068 s, a JIT artifact and not raw CPU: a later probe on one c3-standard-8 node ran the same V8 tier within 3% microVM vs plain (570 vs 555 ms); `--print-opt-code` shows the microVM's TurboFan code adds in doubles (860 bytes) where plain's adds in int32 (552 bytes), because V8's background compiles took 14 to 17 times longer in the guest and its speculation read the loop's feedback only after the sum had left int32 (1e9 iterations 5.76 vs 0.43 s); a second probe that day (one c3-standard-8 node, a fresh pod per variant, 3 to 6 runs each) found the compile as slow on the main thread (`--single-threaded`: TurboFan 5.2 to 6.7 vs 1.1 ms) and at par with the `node` binary copied to tmpfs or with virtiofsd `--cache=always` (1.2 ms): under `--cache=auto` each newly opened file re-reads its pages from the host (about 1000 major faults to map the binary once), so every process re-reads the compiler's code; worker threads compute at par and the clock source is `tsc` in both; a futex wake takes 27 vs 4.6 µs, `mprotect` beside a running thread 21 vs 4.5 µs, and the first touch of a guest page 14.7 vs 1.4 µs (1.7 µs once the host's `shmem_enabled` is `always`: guest memory is shmem and the node's default is `never`); the jsdom file alone, from tmpfs, took 6.5 s microVM vs 5.3 s plain, 6.3 s with `--cache=always` (which is not usable: after a Secret update its mounted file stops resolving in the guest, and a driver takeover rebinds the supervisor through one), 6.0 s with host shmem huge pages added, and 7.7 s with the guest booted `idle=poll`; listing `node_modules` 1.66 / 0.041 / 0.045 s, and 0.046 s from a tmpfs copy in the microVM; one vitest run (core plus one jsdom file) 10.8 s from the task volume (virtiofs) and 9.5 s from tmpfs in the microVM, 5.5 / 5.9 s plain / GitHub, so of the 5.3 s it loses about 1.3 s is virtiofs and 4.0 s nested virtualization. The postgres service keeps its data on virtiofs in the microVM: single-session durable writes 1275 / 2628 / 3861 tps and 928 in the real gate, reads 5988 / 18349 / 8299, writes with durability off (`scripts/gate-pg-fast.sh`) 5814 / 21505 / 9615. The share of each cause in a whole `test` or `test:db` gate, and gate times after the gate-pg-fast and concurrent-gates changes, are unmeasured.
- Request limits (`server/src/config-limits.ts`) are per replica and derived, not load-tested: 600/min per credential is
  six tabs at the SPA's fastest polls (2 to 3 s, about 100/min a tab, `web/src/api/useJobs.ts`). The org rate, 16 MCP
  streams per org and the 60 s statement timeout are ceilings; no production timing was read to set them.
