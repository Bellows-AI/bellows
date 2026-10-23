# Known limits

Capabilities deliberately absent, and figures that are narrower than they look. Read before
reporting a number as measured, or "fixing" anything listed here.

## What the numbers do not cover

- AI usage covers only sessions after the plugin was installed, on machines that have it, and the
  branch is sampled, not tracked — [plugins/agent-telemetry/README.md](../plugins/agent-telemetry/README.md).
- Token and line counts are what the agent wrote, not what survived: no SHA is in the attribute
  allowlist (`server/src/telemetry/otlp.ts`), so no "AI share of this diff" is possible.
- **Null is unmeasured, never zero** across the payload: the workspace checkout total stays null
  until every included checkout has a size (`server/test/routes.workspace.test.ts`).
- Seeded data is deterministic but not stable across changes to `server/src/seed/synthetic.ts`, so
  `e2e/dashboard.spec.ts` asserts structure, not figures.

## Capabilities that are absent

- `POST /api/otlp/v1/logs` accepts and discards (`server/src/routes/ingest.ts`).
- Telemetry needs the executor image to reach a collector — off the compose network, opencode runs
  go unrecorded ([telemetry.md](telemetry.md)).

## Known defects

- **`session_branch.branch` is nullable but sits in the primary key**, so detached-HEAD rows are
  rejected; `server/test/routes.ingest.test.ts` asserts against a stub and cannot catch it. The
  repair and its scope are stated at the key in `server/migrations/005_organizations.sql`.

## Measured versus assumed

- The EBS task volume class in [kubernetes.md](kubernetes.md) is unobserved: `scripts/test-k8s.sh` refuses every
  non-kind context, so no Factory release has been installed on EKS, and `ReadWriteOncePod` on the EBS CSI
  driver and a real runner write are unwatched. See [eks-runbook.md](eks-runbook.md).
- Driver loss and node drain on both executors: `scripts/test-jobs.sh --phase driver-kill` and
  `scripts/test-k8s.sh --cluster --phase takeover` kill a driver at setup, agent, gates and publish;
  no block declares a post-phase helper, so neither has a post window
  (`driver/test/loop-phase-checkpoints.test.ts`). Drain recovery is read from
  `make cluster CLUSTER=<n> LAYOUT=drain && npm run test:k8s -- --cluster --phase drain`, which
  writes `artifacts/k8s/<release>.recovery.tsv`: seconds from the start of `kubectl drain`, at
  `date +%s` resolution, on one laptop's kind cluster. EKS, EFS, spot notices and Karpenter are not
  covered; three runs are a sample, not a bound. Measured 2026-10-22, macOS x86_64 laptop, kind with
  three workers (held/settled seconds): D1 (driver node drained) 24/33, 25/34, 24/30; D2 (runner node
  drained) 12/21, 9/17, 37/46 (the drain itself took 31 s). One more run failed at D2: the
  replacement runner was lost a second time and two interruptions were recorded; the cause is
  not established.
- Throughput and recovery are read from `npm run test:k8s -- --cluster --phase bench`, which writes
  `artifacts/k8s/<release>.bench.tsv` (workload: [executor-testing.md](executor-testing.md)). Measured 2026-10-23,
  macOS x86_64 laptop (8 cores, 16 GiB), one kind node: 0.78 tasks/min at 1 task, 2.8 and 3.1 (1 and 2 drivers)
  at 4; from 8 tasks throughput holds at 3.0 to 3.3 because the node fits about five runner pods
  ("Insufficient cpu, Insufficient memory"), while claim-wait p95 stays under 15 s with no lock waiter, so the
  board's own ceiling is not reached. A killed driver's claims moved on at lease + 2 to 7 s and every task settled
  within lease + 29 s. Targets, read at 4 tasks: >= 2.7 tasks/min on this laptop, claim-wait p95 <= 5 s, claim
  lock-wait p95 <= 25 ms, <= 1 board and <= 2 cluster API requests/s per active task, claims moved on <= lease +
  10 s, settled <= lease + 40 s. A laptop sample, not a bound: EKS, EFS, Karpenter and the docker executor are
  unmeasured, and so is more than one dashboard replica. The per-thread checkout's sync step
  (`driver/src/supervised-steps.ts`) costs 0.35 to 1.5 s mean at 1 to 16 concurrent threads on local-path
  storage, with no trend; the shared-worktree alternative is unmeasured and its code is gone.
