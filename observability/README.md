# Observability dashboards and alert rules

`dashboards/*.json` are Grafana import files and `alerts/*.yaml` are Prometheus rule groups, written against the board's
and the driver's OTLP instruments as a Prometheus backend stores them: `.` becomes `_`, a unit `s` adds `_seconds`, a
counter adds `_total`, a histogram adds `_bucket`, `_sum` and `_count`. The resource's `service.name` is the `job` label
and `service.instance.id` the `instance` label; the chart sets the instance to the pod name, compose sets none, so
`instance` is empty locally.

Import a dashboard in Grafana under Dashboards, New, Import, and pick the Prometheus data source for `DS_PROMETHEUS`.
Load the rules through the Mimir ruler, Prometheus `rule_files` or Grafana's data-source-managed rules. Check the
no-successful-poll rule with `promtool test rules observability/alerts/driver.test.yaml`.

`server/test/observability-drift.test.ts` and `driver/test/observability-drift.test.ts` fail when a queried metric is
not a declared instrument, so a renamed instrument fails a test instead of blanking a panel. The `otelcol_*` series are
the ops collector's own and are not drift-checked.
