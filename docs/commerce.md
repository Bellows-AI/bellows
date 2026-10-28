# Commerce

Optional link to an external commerce service, off by default: the service pushes each org's plan, the board reports every closed execution claim; the board holds no price, no allowance and no enforcement.

## Where things live

| Concern | Code | Test |
| --- | --- | --- |
| `COMMERCE_ENABLED`, `COMMERCE_URL`, `COMMERCE_TOKEN` ([configuration.md](configuration.md)) | `server/src/config-commerce.ts` | `server/test/config.commerce.test.ts` |
| `org_plan` and the usage outbox `commerce_usage_report` | `server/migrations/094_commerce.sql` | `server/test-db/commerce-store.test.ts` |
| Outbox: enqueue closed claims, token-checked lease and settle, member read | `server/src/db/commerce-store.ts` | `server/test-db/commerce-store.test.ts` |
| Plan push write: one guarded upsert, org existence decided by the write | `server/src/db/commerce-plan-writer.ts` | `server/test-db/commerce-plan-writer.test.ts` |
| Outbound `POST {COMMERCE_URL}/v1/orgs/{orgId}/usage` | `server/src/commerce/commerce-client.ts` | `server/test/commerce-client.test.ts` |
| Delivery loop, every replica, `commerce_usage` pass | `server/src/commerce/commerce-loop.ts`, `server/src/main.ts` | `server/test/commerce-loop.test.ts` |
| `GET /api/commerce`, `PUT /api/commerce/orgs/:orgId/plan` | `server/src/routes/commerce.ts`, `server/src/app.ts` | `server/test/routes.commerce.test.ts` |
| The `commerce` credential class | `server/src/auth/plugin.ts` | `server/test/auth.enforcement.test.ts` |

## Contract

- Outbound: bearer `COMMERCE_TOKEN`, body `{records:[{jobId, claimSeq, rootJobId, requestingJobId, launch, adoptsClaimSeq, startedAt, endedAt, durationMs}]}`. The service dedupes on `(orgId, jobId, claimSeq)` and answers `{accepted:[{jobId, claimSeq}]}`.
- Inbound: `PUT` with the same bearer and `{plan, includedMinutes, usedMinutes, periodStart, periodEnd, version}`; `version` is the service's monotonic revision. 200 stored or replayed, 409 older or conflicting (body carries the current `version`), 404 unknown org, 400 malformed.

## Invariants

- **Reported usage is a raw fact.** Every closed `origin = 'claim'` claim is reported with its `launch`; `backfill` and open claims never are. Minutes are read from `job_execution` at lease time, never copied.
- **Only echoed keys are acknowledged.** Any other outcome (status, timeout, malformed or partial answer) leaves the rows to retry with backoff; the token never appears in a result or log.
- **A settle applies only while its lease token stands**, so a replica whose lease lapsed changes nothing.
- **The push answers 200 only after commit**; a retry of a lost 200 is `replayed`. A database failure is 503, never an empty plan or a 200.
- **The push credential is its own class**, enforced in both `AUTH_MODE`s, with no session, personal or worker fallback.
- **One token in both directions**: a leak lets the holder write any org's plan; rotation is a redeploy of both sides.

## Stated limits

- No enforcement, no UI, no pull: a lost or refused push is the service's to retry.
- A claim's `launch` moving `unknown` to `observed` after it was reported is not re-reported.
