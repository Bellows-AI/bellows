# Design system — region: dashboard

Telemetry and charts. `web/src/styles/regions/dashboard.css`; shared system:
[../design-system.md](../design-system.md).

| Concern | Code | Test |
| --- | --- | --- |
| Page frame, control row, and the toolbar's range, scope, coverage and freshness (sans timestamp popup) | `web/src/pages/DashboardPage.tsx`, `web/src/components/AnalyticsToolbar.tsx`, `RangeSelector.tsx`, `ScopeToggle.tsx` | `e2e/dashboard.spec.ts`, `web/test/dashboard.dom.test.tsx`, `web/test/range-selector.test.tsx`, `web/test/dashboard-telemetry.test.tsx`, `web/test/styles.test.ts` |
| Open metric strip, the one empty state, telemetry panels with tertiary legend toggles, the task board section | `web/src/panels/UsageSummaryPanel.tsx`, `TelemetryFrame.tsx`, `TokenUsagePanel.tsx`, `TaskUsagePanel.tsx`, `RecentTasksPanel.tsx` | `web/test/dashboard-summary.test.ts`, `web/test/panels.render.test.tsx`, `web/test/dashboard-telemetry.test.tsx`, `web/test/recent-tasks.dom.test.tsx`, `web/test/dashboard.dom.test.tsx` |
| Chart marks, axes, scales, the sessions sparkline | `web/src/charts/BarChart.tsx`, `Axes.tsx`, `scale.ts`, `Sparkline.tsx` | `web/test/bar-chart.test.tsx`, `web/test/dashboard.dom.test.tsx` |

## Invariants

- Unmeasured renders "—", a measured zero renders 0, the Total tokens card always shows Input and
  Output beside the sum (`totalTokens()`), no figure is broken down per person, and no trend
  comparison or cost appears here.
- Recent tasks is the board, not telemetry: range and scope do not filter it.
- Share bars, the acceptance meter and the sparkline are `aria-hidden` decoration beside a figure;
  the partial-bucket hatch is grayscale-safe.

Classes defined here: `dashboard-controls`, `analytics-toolbar`, `analytics-summary`,
`toolbar-group`, `toolbar-label`, `toolbar-value`, `toolbar-coverage-dot`, `range-dialog-title`,
`range-draft-fields`, `range-draft-actions`, `updated-at-full`, `usage-groups`, `usage-groups-compact`,
`usage-body`, `usage-label`, `usage-caption`, `usage-unmeasured`, `usage-visual`, `usage-pair`,
`usage-meter`, `usage-empty`, `usage-track`, `usage-bar`, `sparkline`, `sparkline-area`,
`sparkline-line`, `sparkline-partial`, `sparkline-hit`, `info-tip`, `info-tip-button`, `info-tip-pop`,
`panel-compact`, `panel-head-actions`, `chart-granularity`, `model-share`, `model-sources-toggle`,
`tick`, `task-title`, `recent-tasks-head`, `recent-tasks-all`, `chart-wrap`, `chart-disclosure`,
`chart-empty`, `chart-tooltip-box`, `grid-alt`, `axis-label`, `bar-primary`, `bar-ok`,
`bar-partial-hatch`, `line`, `bucket-hit`, `legend-button`, `task-usage-model`, `usage-by-model`,
`swatch-primary`, `swatch-ok`.
