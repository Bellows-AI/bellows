# Workflows

A workflow is a graph of nodes the board walks between verdicts; the driver runs one row, the board
decides the next. **Dormant:** no UI offers workflows and none is seeded; the API and engine serve
one created by hand. Checkout, gates and publish are driver machinery, never nodes ([jobs.md](jobs.md)).

| Concern | Code | Test |
| --- | --- | --- |
| Grammar, closed key sets, refusal codes, interpolation | `server/src/db/workflows/workflow-schema.ts`, `workflow-schema-validate.ts`, `workflow-schema-validate-helper-plans.ts` | `server/test/workflow-schema.test.ts`, `workflow-engine.validation.test.ts` |
| Launch parameters, safe regex subset | `server/src/db/workflows/workflow-pattern.ts` | `server/test/workflow-engine.params.test.ts` |
| Transition engine, rest reasons (`REST_BY_KIND`) | `server/src/db/workflows/workflow-engine.ts` | `server/test/workflow-engine.next-transition.test.ts`, `workflow-engine.walkthrough.test.ts`, `workflow-engine.evidence.test.ts` |
| Block registry and expansion compiler | `server/src/db/workflows/workflow-blocks/index.ts`, `types.ts` | `server/test/workflow-block-compiler.test.ts` |
| Built-in blocks | `server/src/db/workflows/workflow-blocks/github-review-reconcile.ts`, `merge-conflict-autofix.ts` | `server/test/workflow-block-github-review-reconcile.test.ts`, `workflow-block-merge-conflict-autofix.test.ts` |
| Durable waits: park, wake, poke, settle | `server/src/db/workflows/workflow-blocks/runtime.ts`, `runtime-settle.ts`, `server/src/db/pr-lifecycle-store.ts` | `server/test/workflow-block-runtime.test.ts`, `workflow-block-runtime-settle.test.ts`, `server/test-db/job-store.block-wait.test.ts` |
| PR follower: the periodic PR read behind a lost webhook (wait wake, merged and closed PRs) | `server/src/pr-follower.ts`, `server/src/db/pr-follow-store.ts`, `server/migrations/082_pr_follow.sql`, `server/src/orgs.ts` | `server/test-db/pr-follow.test.ts` |
| CRUD, scope, compile at create | `server/src/db/workflows/workflow-store.ts`, `server/src/routes/workflows.ts` | `server/test-db/workflow-store.test.ts`, `server/test/routes.workflows.test.ts` |
| Review verdict markers | `server/src/db/workflows/workflow-templates.ts` | `server/test/evidence-policy.test.ts` |
| Launch resolution, `wait/cancel`, `wait/poke` | `server/src/routes/jobs/jobs.ts`, `job-workflow-resolution.ts` | `server/test/routes.jobs.test.ts` |
| Transition inside the verdict transaction | `server/src/db/jobs/job-store-worker.ts` | `server/test-db/job-store.workflow.test.ts` |
| Claim's `publish` flag, helper plans, cancellation fence | `server/src/db/jobs/job-store-claim.ts` | `server/test-db/job-store.workflow.test.ts` |
| Sessions; stop/done/remove on a thread | `server/src/db/jobs/job-store-actions.ts` | `server/test-db/job-store.workflow.test.ts` |
| Columns and the frozen snapshot | `server/migrations/027_workflows.sql`, `030_workflow_params.sql`, `033_job_workflow_name.sql` | `server/test-db/job-store.workflow.test.ts` |
| `review: true` node as review evidence | `server/src/db/evidence-policy.ts` | `server/test/evidence-policy.test.ts` |
| Agent-less nodes, merge-conflict probe | `driver/src/loop-agentless.ts`, `driver/src/scripts/merge-conflict-probe.cjs` | `driver/test/loop.test.ts`, `merge-conflict-probe-script.test.ts` |
| Composer and settings UI, hidden and unrouted | `web/src/panels/TaskComposer.tsx`, `web/src/panels/WorkflowsPanel.tsx`, `web/src/api/useWorkflows.ts` | `web/test/task-composer.render.test.tsx`, `workflows-panel.render.test.tsx` |
| A stub workflow on a real board and driver | `scripts/test-jobs.sh` | — |

## Invariants

- **The stored definition is the expanded graph, never the block reference** — the engine and
  `server/src/routes/jobs/jobs.ts` read `.prompt` off every node unguarded. `server/test-db/workflow-store.test.ts`.
- **`runtime` is never authorable**: it is attached after validation, so a pasted one refuses
  `UNKNOWN_KEY` — `server/test/workflow-schema.test.ts`.
- **The definition and name freeze on the root row at create**; `job.workflow_id` has no foreign key.
  `server/test-db/job-store.workflow.test.ts`.
- **No `workflow` means objective mode on every row** — no snapshot, node or wait.
  `server/test-db/job-store.objective.test.ts`.
- **An unmatched completion or an exhausted bound rests the thread**, never fails or falls through;
  loop bounds count rows for the target node, so every edge into it needs the same `max`.
  `server/test/workflow-engine.next-transition.test.ts`.
- **The publish decision rides the claim and is enforced only in `driver/src/loop-verdict.ts`** —
  `driver/test/docker.test.ts`, `k8s.test.ts`.
- **The follower applies what the webhook would have, idempotently, under its claim**: effects run in the
  follow row's locked transaction, what a wait observed is a per-wait fingerprint of the read (`observed_fingerprint`, surviving re-entry), a merge dedupes on
  `pr_merge`, a PR is followed (slower once closed) while any wait or live thread needs it, and a read
  without an explicit state is a failure that changes nothing.
  `server/test-db/pr-follow.test.ts`.
- **A parked wait holds no `job` row and no lease**; the per-root advisory lock and the claim-time
  cancellation fence prevent a double wake — `server/test-db/job-store.block-wait.test.ts`.

## Stated limits

- Every declared parameter is required; `param` is a reserved node name.
- A definition with no reachable `publish: true` node is refused at create.
- A missed delivery is repaired by the PR follower within `PR_FOLLOW_INTERVAL_MS` (15 min per PR, reads shared
  with the batch observer's rate-limit pause); `wait/poke` releases a wait sooner. Check events never fold a wait.
- Two PR activities in one provider second that leave every field the read returns identical (a second comment,
  say) wake a wait once, not twice; a lost webhook for the second is only repaired by the next change or `wait/poke`.
- Neither built-in block merges or closes a pull request.
