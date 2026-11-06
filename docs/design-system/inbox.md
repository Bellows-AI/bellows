# Design system — region: inbox

The `/tasks` board. Styles: `web/src/styles/regions/inbox.css`; shared primitives and the system
contracts: [../design-system.md](../design-system.md).

| Concern | Code | Test |
| --- | --- | --- |
| Page, tabs and counts, toolbar, chips, rows, states | `web/src/pages/TaskInboxPage.tsx` | `web/test/task-inbox.render.test.tsx` |
| Filter and sort round trip through the URL | `web/src/pages/TaskInboxPage.tsx`, `web/src/api/useTasks.ts` | `web/test/use-tasks.test.ts`, `e2e/journeys.spec.ts`, `e2e/navigation.spec.ts` |
| Row timing | `web/src/format.ts`, `web/src/api/useJobs.ts` | `web/test/task-derivations.test.ts` |
| Row tone, status label, dot | `web/src/task-tree.ts` | `web/test/task-tree.test.ts` |
| Day groups | `web/src/inbox-groups.ts` | `web/test/inbox-groups.test.ts` |
| Toolbar triggers apply on pick | `web/src/pages/TaskInboxPage.tsx` | `web/test/task-inbox.dom.test.tsx` |

## Invariants

- The tab counts read `navigation.counts`, never the applied filters — a filtered view still
  shows the organization total. Needs attention counts `running + review`, the server's own
  `attention` predicate (every task not yet closed).
- `review` stays a URL state without a tab (the sidenav's "more need review" link opens it); it
  shows as a removable "State: Needs review" chip.
- Filters live in the URL: search applies on Enter, the repository, author and sort triggers on
  pick, and chip removal and "Clear filters" are links, so Back undoes them.
- The toolbar wears the composer's quiet `select-trigger`; heading, tabs, search icon and list
  share one left edge.
- The title is the row's one link; its `::after` stretches over the row so the whole row clicks.

Classes defined here: `inbox-new`, `inbox-tabs`, `inbox-tab`, `inbox-tab-count`, `inbox-toolbar`,
`inbox-search`, `inbox-toolbar-divider`, `inbox-trigger`, `inbox-trigger-value`, `is-applied`,
`inbox-author-panel`, `inbox-author-field`, `inbox-chips`, `inbox-chip-remove`, `inbox-clear`,
`inbox-list`, `inbox-group`, `inbox-group-head`, `inbox-group-count`, `inbox-rows`, `inbox-row`,
`inbox-row-turn`, `inbox-row-failed`, `inbox-mark`, `inbox-title`, `inbox-summary`, `is-live`,
`inbox-state`, `inbox-state-waiting`, `inbox-state-done`, `inbox-repo`, `inbox-repo-name`,
`inbox-executor`, `inbox-author`, `inbox-cell-text`, `inbox-when`, `inbox-empty`, `inbox-error`,
`inbox-footer`, `inbox-note`.
