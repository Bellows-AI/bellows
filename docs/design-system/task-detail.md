# Design system — region: task-detail

The task page. `web/src/styles/regions/task-detail.css`; shared system:
[../design-system.md](../design-system.md).

| Concern | Code | Test |
| --- | --- | --- |
| Page frame, grid, panel order, remove dialog | `web/src/pages/TaskDetailPage.tsx`, `web/src/panels/TaskDetail.tsx`, `web/src/components/TaskRemoveDialog.tsx` | `web/test/task-detail.render.test.tsx`, `web/test/task-detail.dom.test.tsx`, `e2e/task-detail.spec.ts` |
| Deletion date under a finished task's header, from the newest finish and the org's retention window; nothing while a run is going, for an unlimited window or a failed read | `web/src/components/TaskDeletionNote.tsx`, `web/src/api/retention.ts` | `web/test/retention.render.test.tsx` |
| Head (title, `#id · Opened`) and the rail's controls tile (wall clock, state pill, small actions, More menu with Rename); the title is clamped to two lines (`task-heading`, `web/src/styles/primitives.css`) and renamed by its author or an admin | `web/src/panels/TaskHeader.tsx`, `web/src/components/TaskRenameDialog.tsx`, `web/src/task-title.ts` | `web/test/task-header.render.test.tsx`, `web/test/task-rename.dom.test.tsx` |
| Collapsible rail tiles; Outcome (published work only), Verification, and one run's exchange, output, close-phase progress strip | `web/src/panels/TaskSection.tsx`, `web/src/panels/TaskOutcome.tsx`, `web/src/panels/TaskRun.tsx` | `web/test/task-outcome.render.test.tsx`, `web/test/task-run.render.test.tsx`, `e2e/task-detail.spec.ts` |
| An agent question in its run's exchange: states, answer value, submit | `web/src/panels/TaskQuestion.tsx`, `web/src/task-question.ts`, `web/src/api/answer-question.ts` | `web/test/task-question.render.test.tsx`, `e2e/task-question.spec.ts` |
| A connection requirement in the newest run's exchange: provider-generic block, bind, dismiss, read-only for anyone but the execution user | `web/src/panels/TaskConnect.tsx`, `web/src/api/connections.ts` | `web/test/task-connect.render.test.tsx`, `web/test/task-connect.dom.test.tsx`, `e2e/task-connect.spec.ts`, `e2e/task-connect-auth.spec.ts` |
| A request's recorded files in its exchange: image preview from the original, download link for every file, "Preview unavailable" when the read fails | `web/src/panels/AttachmentList.tsx` (`AttachmentHistory`), `web/src/panels/TaskRun.tsx` | `web/test/task-detail-attachments.dom.test.tsx`, `e2e/task-detail.spec.ts` |
| Independently scrolling conversation (the only scroll region) with the follow-up composer docked under it; a live-following scroller (conversation, live raw-output well) follows new output only while its reader is near its bottom, and the conversation offers "Jump to latest" otherwise | `web/src/panels/TaskDetail.tsx`, `web/src/use-stick-to-bottom.ts`, `web/src/styles/regions/task-detail.css` | `web/test/stick-to-bottom.test.ts`, `web/test/task-scroll.dom.test.tsx`, `web/test/styles.test.ts`, `e2e/task-detail.spec.ts` |
| Gate tones, follow-up eligibility, a thread's interruptions | `web/src/task-outcome.ts` | `web/test/task-derivations.test.ts` |
| Task activity tile: execution facts, interruptions, activity pulse (latest run, token types) and the Task statistics modal trigger | `web/src/panels/TaskActivity.tsx`, `web/src/charts/PulseChart.tsx`, `web/src/api/useJobActivity.ts` | `web/test/task-activity.render.test.tsx`, `web/test/task-detail.dom.test.tsx`, `e2e/task-detail.spec.ts` |
| Task statistics modal: `task.usage` figures (reviews included), one row per `task.runs[]` entry with expandable models, the task-owned row, estimates/unlocated, models, gate counts by outcome with reused attribution and PR links ("—" when not recorded); loading/unavailable/partial/provisional | `web/src/components/TaskStatsDialog.tsx`, `web/src/task-stats.ts` | `web/test/task-stats.test.ts`, `web/test/task-detail.dom.test.tsx`, `web/test/task-stats-dialog.dom.test.tsx`, `web/test/styles.test.ts`, `e2e/task-detail.spec.ts` |

## Invariants

- Nothing here is inferred: a run with no stored response renders none, a run the pipeline holds
  nothing about gets one sentence, not a zero line, and no PR state is shown — the board has none.
- Nothing is said twice: state, clock and actions live in the controls tile, execution facts in
  Task activity, published work in Outcome; the head and the run articles repeat none of them.
- DOM order is visual order — head, rail (`task-rail`), main; from 1024px the rail is a full-height
  right column from the app bar down. Tile open state is never remembered.

Classes defined here: `task-layout`, `task-main`, `task-thread`, `task-conversation`, `task-jump`, `task-head`, `task-rail`, `task-controls`, `task-controls-state`, `task-wait`, `task-clock-value`, `task-section`, `task-section-head`, `task-section-aside`, `task-section-body`, `task-publish`, `task-follow-up`, `task-summary`, `task-clock`, `task-actions`,
`task-closed`, `task-meta-line`, `task-pill-wait`,
`task-pill-done`, `task-outcome-label`, `task-history-item`, `task-branch`,
`task-copy`, `task-remove-title`, `task-remove-actions`, `task-rename-label`, `task-rename-field`, `msg-user`,
`msg-meta`, `chat-exchange`, `chat-exit`, `chat-activity`, `chat-gate-list`,
`chat-output`, `chat-resume`, `chat-done`, `chat-stop`, `chat-remove`, `run-summary`,
`run-output`, `run-checking`, `run-spinner`, `run-well`, `gate-output-wrap`, `question`,
`question-set`,
`question-chip`, `question-option`, `question-hint`, `question-other`, `question-error`,
`question-status`, `question-answers`, `connect-actions`, `task-stats`, `task-stats-trigger`, `task-stats-scope`,
`task-stats-summary`, `task-stats-note`, `task-stats-head`, `task-stats-totals`, `task-stats-runs`,
`task-stats-pulse`, `task-stats-line`, `task-stats-usage`, `task-stats-owned`, `task-stats-models`,
`task-stats-run-note`, `task-stats-toggle`, `task-stats-detail`, `pulse`, `pulse-detailed`, `pulse-axis`,
`pulse-line`, `pulse-dot`, `pulse-input`, `pulse-output`, `pulse-cache-read`,
`attachment-preview`, `pulse-cache-creation`, `pulse-scale`, `pulse-legend`, `pulse-swatch`.
