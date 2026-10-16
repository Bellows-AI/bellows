# Delivery plan

Each numbered item is one child issue of the epic. Every item lands its Kubernetes and Docker
halves in the same change. Unchecked items are not implemented. `→` names hard dependencies.

## Phase 0 — close the open decisions (no runtime change)

- [x] 0.1 (#761) In-pod control contract. Pick the gate/service bootstrap (init container copies a static
  control binary into an emptyDir used as entrypoint; authenticated Unix socket not mounted into the
  agent container). Prove it on kind with a real declared gate image, non-root, no shared PID
  namespace, and a forged-response test from the agent container. Record the resource model:
  pod requests are the sum of all containers for the pod's whole life — measure the cost against
  today's short-lived aux Jobs before Phase 2 starts.
- [x] 0.2 (#762) Artifact store. Pick backend and auth (S3 on EKS; RustFS in compose and as a service;
  filesystem backend for `npm test`), chunk/flush defaults, retention, recovery-volume TTL, quotas.
- [x] 0.3 (#763) Follow-up continuity. Decide: task PVC retained per root thread until idle TTL, then a
  follow-up restores from the checkpoint manifest (branch `factory/<root>`, untracked-file bundle,
  raw session for Claude `--resume` / OpenCode data). Decide the lost per-member package cache
  (`claim.ts` `.cache/<owner>/<repo>`): accept slower installs, or a scoped rebuildable cache.

## Phase 1 — durable transcripts on today's runtime (ships value first)

- [ ] 1. (#764) Artifact store and index → 0.2. Replace `job_artifact` (046) with immutable
  manifest + chunk tables keyed org/member/root/job/claim_seq/executor/session/stream; chunk
  sequence + sha256 make retries idempotent; artifact-finalization status separate from verdict.
  Store backend behind one interface. Scoped read/write; cross-tenant refusal test.
- [x] 2. (#765) Chunked upload protocol → 1. Replace `POST /api/jobs/:id/artifact` (single 512 KiB
  upsert, live-lease only) with chunk put + manifest finalize authorized by claim sequence, so a
  stale or reclaimed attempt may finish its own prefix but advances nothing authoritative.
- [x] 3. (#766) Claude continuous exporter → 2. Exporter process in the runner pod / docker group tails
  `projects/*/<session>.jsonl`; partial trailing records, rotation, bounded spool, backpressure
  (pause or explicit failure, never drop); exposes oldest-unacked age and bytes. Lossless — drops
  `TRANSCRIPT_LIMIT_BYTES`. Deletes the `claudeTranscriptJobSpec` close-read Job and its docker twin.
- [ ] 4. (#767) OpenCode exporter → 2. Consistent read (SQLite backup API or supported export), raw rows
  plus normalized stream with provenance; tool calls and usage retained. Deletes
  `opencodeTranscriptJobSpec`. Moves opencode data from per-member to per-task directory.
- [ ] 5. (#768) Analysis reads → 1. API/CLI read across chunks, attempts, sessions and streams; partial,
  truncated and deleted states; pagination. Reviewer/subagent sessions linked to parent attempt.
  Transcript exports stay out of token metrics (OTEL wins in `session_source`; pin it).

## Phase 2 — one task pod, still on the shared volume

- [x] 6. (#769) Execution plan at claim → 0.1. Board resolves gate and service images from `.bellows.yaml`
  at the claimed revision via the GitHub API (removes the server filesystem read in
  `workspace/bellows.ts` and the `bellowsJobSpec` readout). Rejects port collisions, undeclared
  images and unsupported plans before launch with an actionable error.
- [ ] 7. (#770) Supervisor and state machine → 6. Supervisor container owns
  prepare→setup→execute→verify→publish→finalize→report; agent is a child container; Stop,
  questions, deadlines and ad-hoc commands route to the supervisor; agent exit leaves it alive.
  Driver keeps lease, ConfigMap claim fencing and reaper.
- [ ] 8. (#771) Executor-image steps into the supervisor → 7. Sync, reclaim, tree probe, review snapshot,
  publish steps and allowlisted helpers run in the supervisor; publish token only in the
  supervisor container. Publication gets a persisted operation identity and remote reconciliation.
  Deletes sync/reclaim/publish/helper aux Jobs and their `factory-(sync|publish|helper)-…-env`
  admission names (also retires the nonce helper-secret reaper gap).
- [ ] 9. (#772) Gates and setup as predeclared containers → 7. Uses the 0.1 bootstrap; same environment
  for setup and every gate; revision-bound evidence unchanged. Deletes `gateJobSpec` and
  `factory-gate-…-env`.
- [ ] 10. (#773) Services as in-pod containers → 7. localhost with `hostAliases` for service names,
  readiness and restart in the supervisor. Deletes service Pods, headless Services, the
  `factory.unhardened` exemption, pod/service/event RBAC and the service pod-to-pod netpol rule.
- [ ] 11. (#774) Internal reviewer in the pod → 8. Separate container, credentials and budget on the
  frozen snapshot; own session identity. Standalone board review tasks stay separate runners.
  After 8–11 the driver creates no Job but the task pod; assert it in `k8s.test.ts`.

## Phase 3 — remove EFS

- [ ] 12. (#775) Task-owned PVC → 7, 0.3. Driver creates one explicitly managed PVC per root thread
  (RWOP on EBS, RWO on kind), not pod-owned; reaper never deletes it before artifacts are
  acknowledged; claim sequence still fences writers. Docker: one named volume per root.
- [ ] 13. (#776) Independent checkout and restore → 12. Replace member clone + linked worktree
  (`git-worktree*.cjs`) with a per-task clone (partial clone to cap clone time); retry and
  follow-up semantics preserved; restore from completed checkpoint manifests only.
- [ ] 14. (#777) Server leaves the filesystem → 6, 13. Delete `workspace/{reconcile,provision,purge,facts}`
  filesystem code, `ORG_WORKSPACE_ROOT`, the API mount and their routes; facts become metadata.
  UI changes run `npm run verify:ui`.
- [ ] 15. (#778) Chart and docs → 12–14. Drop the RWX workspaces PVC and EFS steps; EBS storage class;
  update `docs/kubernetes.md`, `docs/workspace.md`, `docs/eks-runbook.md` table rows and the
  pinned prose in `k8s-docs` / `docs.eks-storage` tests in the same change.

## Phase 4 — acceptance

- [ ] 16. (#779) Failure matrix on kind and EKS: agent kill, pod and node loss, upload outage, full spool,
  stale claim, driver restart, publication uncertainty, cross-AZ restore, PVC cleanup protection.
  One task, failure, retry and follow-up with no EFS provisioning; analysis after runner deletion.
- [ ] 17. (#780) Update `openspec/specs/executor-transcripts/spec.md`, owning doc rows; archive change.

## Validation gates

- Run focused driver/runner, artifact, transcript, security and database suites as each surface changes.
- Run `npm run test:executors`, typecheck, lint and build for each runtime child issue.
- Run `npm run test:jobs` and Kubernetes cluster tests for actual lifecycle behavior.
- Run `npm run verify:ui` whenever frontend code or rendered payloads change; inspect screenshots.
