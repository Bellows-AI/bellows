# Design system — region: task-detail

The task page. `web/src/styles/regions/task-detail.css`; shared system:
[../design-system.md](../design-system.md).

| Concern | Code | Test |
| --- | --- | --- |
| Page frame, grid, panel order, remove dialog | `web/src/pages/TaskDetailPage.tsx`, `web/src/panels/TaskDetail.tsx`, `web/src/components/TaskRemoveDialog.tsx` | `web/test/task-detail.render.test.tsx`, `web/test/task-detail.dom.test.tsx`, `e2e/task-detail.spec.ts` |
| Head: state pill, metadata, action row | `web/src/panels/TaskHeader.tsx` | `web/test/task-header.render.test.tsx` |
| Outcome rail (interruptions included), and one run's exchange, output, close-phase progress strip, gates, published work | `web/src/panels/TaskOutcome.tsx`, `web/src/panels/TaskRun.tsx` | `web/test/task-outcome.render.test.tsx`, `web/test/task-run.render.test.tsx`, `e2e/task-detail.spec.ts` |
| An agent question in its run's exchange: states, answer value, submit | `web/src/panels/TaskQuestion.tsx`, `web/src/task-question.ts`, `web/src/api/answer-question.ts` | `web/test/task-question.render.test.tsx`, `e2e/task-question.spec.ts` |
| Gate tones, follow-up eligibility, a thread's interruptions | `web/src/task-outcome.ts` | `web/test/task-derivations.test.ts` |
| Activity pulse (latest run, token types) and the Task statistics modal trigger | `web/src/panels/TaskActivity.tsx`, `web/src/charts/PulseChart.tsx`, `web/src/api/useJobActivity.ts` | `web/test/task-activity.render.test.tsx`, `web/test/task-detail.dom.test.tsx`, `e2e/task-detail.spec.ts` |
| Task statistics modal: `task.usage` figures (reviews included), one row per `task.runs[]` entry with expandable models, the task-owned row, estimates/unlocated, models, gate counts by outcome with reused attribution and PR links ("—" when not recorded); loading/unavailable/partial/provisional | `web/src/components/TaskStatsDialog.tsx`, `web/src/task-stats.ts` | `web/test/task-stats.test.ts`, `web/test/task-detail.dom.test.tsx`, `web/test/task-stats-dialog.dom.test.tsx`, `e2e/task-detail.spec.ts` |

## Invariants

- Nothing here is inferred: run history shows recorded stamps only, a run with no stored response
  renders none, a run the pipeline holds nothing about gets one sentence, not a zero line.
- DOM order is visual order — the outcome rail comes first at every width, the conversation and
  composer next, the supporting panels (`task-support`) last; from 1024px the rail and panels
  share the right column.

Classes defined here: `task-layout`, `task-main`, `task-support`, `task-summary`, `task-clock`, `task-actions`,
`task-action-help`, `task-closed`, `task-meta-line`, `task-opened-by`, `task-pill-wait`,
`task-pill-done`, `task-outcome-body`, `task-outcome-label`, `task-history-item`, `task-branch`,
`task-copy`, `task-verification-counts`, `task-remove-title`, `task-remove-actions`, `msg-user`,
`msg-meta`, `chat-exchange`, `chat-exit`, `chat-runtime`, `chat-activity`, `chat-gate-list`,
`chat-output`, `chat-resume`, `chat-done`, `chat-stop`, `chat-remove`, `run-label`, `run-summary`,
`run-output`, `run-history`, `run-close-phase`, `run-close-gates`, `run-well`, `run-publish`, `gate-output-wrap`, `question`,
`question-set`,
`question-chip`, `question-option`, `question-hint`, `question-other`, `question-error`,
`question-status`, `question-answers`, `task-stats`, `task-stats-trigger`, `task-stats-scope`,
`task-stats-summary`, `task-stats-note`, `task-stats-head`, `task-stats-totals`, `task-stats-runs`,
`task-stats-pulse`, `task-stats-line`, `task-stats-usage`, `task-stats-owned`, `task-stats-models`,
`task-stats-run-note`, `task-stats-toggle`, `task-stats-detail`, `pulse`, `pulse-detailed`, `pulse-axis`,
`pulse-line`, `pulse-dot`, `pulse-input`, `pulse-output`, `pulse-cache-read`,
`pulse-cache-creation`, `pulse-scale`, `pulse-legend`, `pulse-swatch`.
