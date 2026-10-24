# Design system — region: batches

The `/batches` pages: list, draft composer, a started batch's monitor. Styles:
`web/src/styles/regions/batches.css`; shared system: [../design-system.md](../design-system.md);
the batch contract: [../batches.md](../batches.md).

| Concern | Code | Test |
| --- | --- | --- |
| List, new draft, detail routes | `web/src/App.tsx`, `web/src/pages/BatchesPage.tsx`, `web/src/pages/BatchNewPage.tsx`, `web/src/pages/BatchDetailPage.tsx` | `web/test/batch-pages.render.test.tsx`, `e2e/batches.spec.ts` |
| Draft: save, check launch, start | `web/src/panels/BatchDraft.tsx`, `web/src/api/useBatches.ts` | `web/test/batch-pages.render.test.tsx`, `e2e/batches.spec.ts` |
| Draft form: stages, parallel tasks, policies, per-field issues | `web/src/panels/BatchEditor.tsx`, `web/src/batch-model.ts` | `web/test/batch-model.test.ts` |
| Inherited versus overridden, shown before launch | `web/src/panels/BatchPlanReview.tsx`, `web/src/batch-model.ts` | `web/test/batch-model.test.ts`, `e2e/batches.spec.ts` |
| Monitor: stage rows, task cards, human gate, retry, accept, report | `web/src/panels/BatchMonitor.tsx` | `web/test/batch-pages.render.test.tsx`, `web/test/batch-detail.dom.test.tsx` |
| Verdict, task state labels, retry eligibility, morning report | `web/src/batch-model.ts` | `web/test/batch-model.test.ts` |
| Task page backlink | `web/src/components/BatchBacklink.tsx`, `server/src/routes/batches/batch-handlers.ts` (`?task=`) | `server/test/routes.batches.test.ts`, `e2e/batches.spec.ts` |
| Sidenav item | `web/src/nav-model.ts` | `web/test/nav-model.test.ts` |
| Desktop and mobile widths without page overflow | — | `e2e/batches.spec.ts` |

## Invariants

- The browser decides nothing the board decides: no scheduler, no completion rule, no gate
  judgement. Every control is one request to `/api/batches`; the record read back is the state.
- A draft is checked by `validateBatchPlan` before a write and its issues are shown at the field
  they name by path; `check launch` and `start` act on the saved draft and stay off while the form
  differs from it.
- A human gate always says it resumes by itself (`GATE_RESUMES_AUTOMATICALLY`) and names the pull
  request to review and merge; the board never merges.
- Every effective stage policy, executor and target renders with `inherited` or `overridden`, so a
  launch applies nothing unseen.
- Stated limits: no budgets (the plan has none), no automatic plan generation, no DAG editing,
  and a second target is added or removed through the CLI.

Classes defined here: `batch-new`, `batch-editor`, `batch-form`, `batch-field-row`, `batch-field`,
`batch-problem`, `batch-check`, `batch-task-edit`, `batch-actions`, `batch-stage`,
`batch-stage-head`, `batch-tasks`, `batch-task`, `batch-task-head`, `batch-objective`,
`batch-links`, `batch-wait`, `batch-gate`, `batch-origin`, `batch-review-stages`, `batch-backlink`.
