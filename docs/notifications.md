# Notifications

The durable event a delivery stage reads when a task becomes ready or blocked; the connector contract and `deliver` classify a send; the outbox that calls them comes later (BEL-129).

| Concern | Code | Test |
| --- | --- | --- |
| Event model and builder (`notificationEventOf`, kinds) | `core/src/notifications.ts` | `core/test/notifications.test.ts` |
| Task title, the one derivation (first line of the command) | `core/src/task-title.ts` | `core/test/task-title.test.ts` |
| Emission: table, function and deferred trigger on `job.status` | `server/migrations/102_notification_event.sql` | `server/test-db/notification-events.test.ts` |
| Delivery result (`SendResult`, reason lists, `isSendResult`) | `core/src/notifications.ts` | `core/test/notifications.test.ts` |
| Connector contract, registry, `deliver` classification | `server/src/notifications/connector.ts` | `server/test/notifications.deliver.test.ts` |
| Fake connector for delivery tests | `server/test/notifications-fake-connector.ts` | `server/test/notifications.deliver.test.ts` |

## Invariants

- The event is written in the status write's transaction, judged on the status the transaction commits: `server/migrations/102_notification_event.sql`, `server/test-db/notification-events.test.ts`.
- One event per (job, kind): the id is `md5(job_id || '/' || kind)::uuid`, so a policy refusal (`succeeded` then `failed` in one transaction) yields `task.blocked` only: `server/test-db/notification-events.test.ts`.
- The row copies the raw command and the frozen `workflow_name`; the title is derived only in core: `core/src/notifications.ts`, `core/src/task-title.ts`.
- A no-op or replayed settle, a takeover, a `running` to `queued` interruption and a stop emit nothing: `server/test-db/notification-events.test.ts`.
- No `pg_notify`; delivery polls: `core/test/polling-authority.test.ts`.
- A thrown, aborted or malformed send is retryable, never permanent; only a well-formed connector verdict or a refused config parks: `server/src/notifications/connector.ts`, `server/test/notifications.deliver.test.ts`.
- A result carries closed reasons only and the config never rides the event, so neither leaks a credential; connector credentials are not stored yet, the first real channel adds them: `core/src/notifications.ts`, `server/test/notifications.deliver.test.ts`.
- Adding a channel is one connector file passed to `createConnectorRegistry`; `deliver` is bounded by the caller's signal, the outbox owns the deadline: `server/src/notifications/connector.ts`.
