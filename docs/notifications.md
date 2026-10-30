# Notifications

The durable event a delivery stage reads when a task becomes ready or blocked; this slice records events, delivery comes later.

| Concern | Code | Test |
| --- | --- | --- |
| Event model and builder (`notificationEventOf`, kinds) | `core/src/notifications.ts` | `core/test/notifications.test.ts` |
| Task title, the one derivation (first line of the command) | `core/src/task-title.ts` | `core/test/task-title.test.ts` |
| Emission: table, function and deferred trigger on `job.status` | `server/migrations/102_notification_event.sql` | `server/test-db/notification-events.test.ts` |

## Invariants

- The event is written in the status write's transaction, judged on the status the transaction commits: `server/migrations/102_notification_event.sql`, `server/test-db/notification-events.test.ts`.
- One event per (job, kind): the id is `md5(job_id || '/' || kind)::uuid`, so a policy refusal (`succeeded` then `failed` in one transaction) yields `task.blocked` only: `server/test-db/notification-events.test.ts`.
- The row copies the raw command and the frozen `workflow_name`; the title is derived only in core: `core/src/notifications.ts`, `core/src/task-title.ts`.
- A no-op or replayed settle, a takeover, a `running` to `queued` interruption and a stop emit nothing: `server/test-db/notification-events.test.ts`.
- No `pg_notify`; delivery polls: `core/test/polling-authority.test.ts`.
