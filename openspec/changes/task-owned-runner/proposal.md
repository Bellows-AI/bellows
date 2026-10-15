# Proposal: task-owned runner and durable artifacts

## Why

Execution currently spreads sync, gates, helpers, review snapshots, publication and session
readout across containers or Kubernetes Jobs sharing a workspace filesystem. A task must be
able to complete and recover without EFS, while retaining transcripts for later analysis.

## What Changes

- One task-attempt pod owns preparation, agent execution, gates, helpers, services, publication,
  checkpoints and transcript export. No independent auxiliary execution Jobs are created.
- A trusted supervisor controls the lifecycle; the agent is a child execution environment.
  Separate containers inside the pod preserve declared images and credential boundaries.
- A task-owned persistent volume holds the active checkout, session databases and upload spool.
  Git holds published source; object storage holds checkpoints and immutable artifacts;
  PostgreSQL holds ownership, manifests and lifecycle metadata.
- The external driver retains scheduling, leases, fencing and orphan reconciliation.
- Transcript collection becomes continuous and executor-neutral, with explicit completeness,
  retention and recovery states. Removal of an agent does not remove its transcript spool.
- Docker implements the same lifecycle through a task-owned container group and volume.
  Replace old contracts and callers together; do not add a compatibility mode.

## Capabilities

- Added: `task-runner-lifecycle` (specified in `specs/task-runner-lifecycle/spec.md`).
- Modified: `executor-transcripts`; the existing volume-only/headless-only contract is replaced
  by the requirements in this change, including OpenCode exports and durable analysis access.

## Non-goals

- No implementation in this planning change; no performance or cost savings claimed.
- No shared writable member checkout, nested container daemon or cluster API credentials in agents.
- No consolidation of distinct board workflow tasks into one long-lived pod.

## Impact

Owning code and tests, blockers, delivery order and acceptance are recorded in `design.md`,
`tasks.md` and `specs/task-runner-lifecycle/spec.md`. Runtime docs change with implementation.
