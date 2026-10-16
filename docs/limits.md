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

- The EFS storage contract in [kubernetes.md](kubernetes.md) was observed on a real EKS cluster
  (eu-central-1, 2026-09-30), not quoted. What is still unobserved is the chart:
  `scripts/test-k8s.sh` refuses every non-kind context, so no Factory release has been
  installed there and a real sign-in and a real runner write on EFS remain unwatched. See
  [eks-runbook.md](eks-runbook.md).
