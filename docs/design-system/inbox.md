# Design system — region: inbox

The `/tasks` board. Styles: `web/src/styles/regions/inbox.css`; shared primitives and the system
contracts: [../design-system.md](../design-system.md).

| Concern | Code | Test |
| --- | --- | --- |
| Page, count strip, filters, chips, rows, states | `web/src/pages/TaskInboxPage.tsx` | `web/test/task-inbox.render.test.tsx` |
| Filter and sort round trip through the URL | `web/src/pages/TaskInboxPage.tsx`, `web/src/api/useTasks.ts` | `web/test/use-tasks.test.ts`, `e2e/journeys.spec.ts`, `e2e/navigation.spec.ts` |
| Row timing | `web/src/format.ts`, `web/src/api/useJobs.ts` | `web/test/task-derivations.test.ts` |
| Row tone, status label, dot | `web/src/task-tree.ts` | `web/test/task-tree.test.ts` |

## Invariants

- The count strip reads `navigation.counts`, never the applied filters — a filtered view still
  shows the organization total.
- Filters live in the URL: inputs are controlled and re-synced from it, and chip removal and
  "Clear filters" are links, so Back undoes them.

Classes defined here: `inbox-new`, `inbox-counts-strip`, `inbox-counts-caption`, `inbox-counts`,
`inbox-count`, `inbox-count-value`, `inbox-count-label`, `inbox-filters`, `inbox-tabs`, `inbox-search`,
`inbox-sort`, `inbox-chips`, `inbox-chip-remove`, `inbox-clear`, `inbox-list`, `inbox-columns`,
`inbox-rows`, `inbox-title`, `inbox-summary`, `inbox-state-waiting`, `inbox-state-done`, `inbox-repo`,
`inbox-author`, `inbox-cell-text`, `inbox-when`, `inbox-empty`, `inbox-error`, `inbox-footer`,
`inbox-note`.
