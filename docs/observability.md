# Observability

How the board and the driver emit their own logs and traces over OTLP, and what a record or a span may carry. What the
runners' executors emit, and the metrics instruments, are in [telemetry.md](telemetry.md).

| Concern | Code | Test |
| --- | --- | --- |
| Logs: one pino root, `component` children, `trace_id`/`span_id` from the active span, stdout plus the OTEL LoggerProvider | `server/src/log.ts` | `server/test/log.trace.test.ts`, `server/test/helpers-log.ts` |
| Log redaction: credential headers and fields blanked, the request serializer logs the route pattern, Fastify's not-found message rewritten | `server/src/log.ts` | `server/test/log.redact.test.ts` |
| Errors in records: the `err` serializer and `describeError` keep the class, code, kind and status, never the message; shutdown logs before the SDK stops | `server/src/log.ts`, `server/src/shutdown.ts` | `server/test/log.content.test.ts`, `server/test/shutdown.logs.test.ts` |
| No repository or branch name in a log call | every `logger(...)` call in `server/src` | `server/test/log.content.test.ts` |
| `console` banned in `server/src`, except the three operator-facing CLIs | `biome.json` | `core/test/biome.test.ts` |
| SDK start, the logs endpoint variable, the SDK's own diagnostics (stdout, one line a minute) | `server/src/otel.ts`, `server/src/otel-register.ts` | `server/test/otel.test.ts` |
| URL scrubbing on spans: server spans keep the route pattern, client spans keep `scheme://host` | `server/src/otel-scrub.ts` | `server/test/otel.scrub.test.ts` |
| Driver: the same logger, redaction, `errorClass`/`describeError` and client-span URL scrubber, copied (the driver imports nothing from the server) | `driver/src/log.ts`, `driver/src/otel.ts`, `driver/src/otel-scrub.ts` | `driver/test/log.test.ts`, `driver/test/otel.test.ts`, `driver/test/otel.scrub.test.ts` |
| Driver log content: no interpolated error message, tool output, token, repository or branch in any log call | every log seam in `driver/src` | `driver/test/log.content.test.ts` |
| Driver exit: the SDK is flushed (raced against 2 s) on every normal drain end and on a handover | `driver/src/shutdown.ts`, `driver/src/index.ts` | `driver/test/shutdown.test.ts` |
| Postgres spans: the verb only | `server/src/pg-trace.ts` | `server/test/pg-trace.test.ts` |
| Ops collector: board and driver export to it, tail-sampled, forwarded to any OTLP backend; ingress from board and driver pods only | `charts/factory/files/ops-collector.yaml`, `charts/factory/templates/ops-collector.yaml`, `charts/factory/templates/ops-collector-networkpolicy.yaml`, `docker-compose.yml` | `driver/test/ops-collector.test.ts`, `driver/test/compose.test.ts`, `scripts/test-k8s.sh` |

## Invariants

- **A log record is JSON with `level`, `time`, `msg` and `component`**; `trace_id` and `span_id` appear only inside a
  span. The OTLP copy maps level 10-60 to severity TRACE-FATAL, `msg` to the body and the other fields to attributes.
- **Serializers and `redact` run before any destination**, so the OTLP copy is never less redacted than stdout.
- **A record never carries an error's message, stack or cause**: a client error spells the request it failed on, which
  names a repository. Log `{ err }` (serialized to its class) or `describeError(e)` in a line.
- **The close failure is logged before the SDK shuts down**, so it is exported (`closeOnSignal`).
- **A log call never names a repository or a branch**, in its message or a field: it carries the job, batch or org id.
- **No URL path or query carries a credential into a span**: `url.full` and `http.url` are `scheme://host`, a server
  span's `url.path` and `http.target` are the route pattern (`<unmatched>` for none), and `url.query` is absent.
- **The scrubber joins the tracer provider's own processor list** because `NodeSDK` builds the env exporters only when
  it is given no `spanProcessors`; a provider that no longer has that list fails the start instead of exporting URLs.
- **Logging never blocks or fails a request**: stdout is synchronous, the OTLP side only enqueues into the SDK's
  bounded batch processor, and a throwing emit is swallowed.
- **The SDK's diagnostics go to stdout only**, never through the LoggerProvider, at most one line a minute.
- **The driver's log lines carry closed words only**: an error as `describeError(e)`, an object by kind (never its name, which carries ids and lease tokens), a cluster refusal as verb, resource kind, status and reason word. The board-bound reason or output text is separate and keeps its detail.
- **The ops collector never exports to the board's `/api/otlp`**: its one exporter is the operator's backend.
- **Runner pods never reach the ops collector**: its ingress policy admits board and driver pods only, and compose keeps it on the `ops` network runners never join. Compose has no lane that boots the `observability` profile; its proof is static.
