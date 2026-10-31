# Notifications

The durable event a delivery stage reads when a task becomes ready or blocked, or its agent asks a question; the connector contract and `deliver` classify a send; an org's subscriptions say who hears about it; the outbox fans an event out to them at emission and a delivery loop sends each row.

| Concern | Code | Test |
| --- | --- | --- |
| Event model and builder (`notificationEventOf`, kinds) | `core/src/notifications.ts` | `core/test/notifications.test.ts` |
| Task title, the one derivation (first line of the command) | `core/src/task-title.ts` | `core/test/task-title.test.ts` |
| Emission: table, function and deferred trigger on `job.status` | `server/migrations/102_notification_event.sql` | `server/test-db/notification-events.test.ts` |
| Task-question emission: per-question id, text snapshot, insert trigger on `job_question` (107) | `server/migrations/107_notification_task_question.sql` | `server/test-db/notification-question.test.ts` |
| Delivery result (`SendResult`, reason lists, `isSendResult`) | `core/src/notifications.ts` | `core/test/notifications.test.ts` |
| Connector contract, registry, `deliver` classification | `server/src/notifications/connector.ts` | `server/test/notifications.deliver.test.ts` |
| Fake connector for delivery tests | `server/test/notifications-fake-connector.ts` | `server/test/notifications.deliver.test.ts` |
| Discord connector: webhook credential check, embed, status map | `server/src/notifications/discord.ts` | `server/test/notifications.discord.test.ts` |
| Fake Discord webhook server (recorded answer shapes) | `server/test/fake-discord.ts` | `server/test/notifications.discord.test.ts` |
| Production registry, the one list `main.ts` passes to routes and delivery | `server/src/notifications/registry.ts` | `server/test/notifications.delivery.test.ts` |
| Manual real-channel check, skipped unless `DISCORD_TEST_WEBHOOK_URL` is set | `server/test/notifications.discord-live.test.ts` | `server/test/notifications.discord-live.test.ts` |
| Subscriptions: table (103) | `server/migrations/103_notification_subscription.sql` | `server/test-db/notification-subscriptions.test.ts` |
| Subscription store, org-bound CRUD | `server/src/notifications/subscription-store.ts` | `server/test-db/notification-subscriptions.test.ts` |
| Subscription credential: secret identity, fail-closed read, row columns (111) | `server/src/notifications/subscription-credential.ts`, `server/migrations/111_notification_credential.sql` | `server/test-db/notification-outbox.test.ts`, `server/test-db/notification-subscriptions.routes.test.ts` |
| Outbox: table, due index and fan-out at emission (104) | `server/migrations/104_notification_outbox.sql` | `server/test-db/notification-outbox.test.ts` |
| Task-ready narrowing and PR link (105) | `server/migrations/105_notification_task_ready.sql` | `server/test-db/notification-events.test.ts` |
| Task-blocked narrowing, batch attention trigger and shared fan-out function (106) | `server/migrations/106_notification_task_blocked.sql` | `server/test-db/notification-events.test.ts`, `server/test-db/notification-blocked.test.ts` |
| Outbox store: lease, settle, release | `server/src/notifications/outbox-store.ts` | `server/test-db/notification-outbox.test.ts` |
| Delivery loop, every replica, `notification_delivery` pass | `server/src/notifications/delivery-loop.ts`, `server/src/main.ts` | `server/test/notifications.delivery.test.ts` |
| Backoff constants and SQL, shared with commerce | `server/src/db/outbox-backoff.ts` | `server/test-db/notification-outbox.test.ts` |
| Non-overlapping interval loop, shared with commerce | `server/src/interval-loop.ts` | `server/test/interval-loop.test.ts` |
| Subscription body validation against the registry | `server/src/notifications/subscription-fields.ts` | `server/test/notifications.subscription-fields.test.ts` |
| Subscription routes (`/api/org/notification-subscriptions`) | `server/src/routes/notification-subscriptions.ts` | `server/test-db/notification-subscriptions.routes.test.ts` |

## Invariants

- The event is written in the status write's transaction, judged on the status the transaction commits: `server/migrations/102_notification_event.sql`, `server/test-db/notification-events.test.ts`.
- One event per (job, kind): the id is `md5(job_id || '/' || kind)::uuid` (`task.question` is one per (job, question): `md5(job_id || '/' || question_id || '/task.question')::uuid`) (a batch event's job is the thread head), so a policy refusal (`succeeded` then `failed` in one transaction) yields `task.blocked` only: `server/test-db/notification-events.test.ts`.
- `task.question` is emitted once when a question is inserted pending and answerable at commit (running job, same lease, no stop requested), snapshotting its texts; answering, closing or expiring it never emits: `server/migrations/107_notification_task_question.sql`, `server/test-db/notification-question.test.ts`.
- The row copies the raw command and the frozen `workflow_name`; the title is derived only in core: `core/src/notifications.ts`, `core/src/task-title.ts`.
- A no-op or replayed settle, a takeover, a `running` to `queued` interruption, a stop, a batch automatic retry or repair, and a workflow failure whose verdict queued a successor or re-parked into an open wait emit nothing: `server/test-db/notification-events.test.ts`.
- `task.ready` is emitted only for the row the board shows as Needs review: a succeeded thread head (newest by created_at, id) that is not a review and not done, open wait or not; it snapshots the thread's `job_pr.pr_url`: `server/migrations/105_notification_task_ready.sql`, `server/test-db/notification-events.test.ts`.
- `task.blocked` is emitted for a non-batch, non-review, not-done thread head with no parked round under an open wait, and for a batch task once `attention` is set except a question on a running task; the batch reason is the attention code plus the head's failure, never `wait_reason`: `server/migrations/106_notification_task_blocked.sql`, `server/test-db/notification-blocked.test.ts`.
- No `pg_notify`; delivery polls: `core/test/polling-authority.test.ts`.
- A thrown, aborted or malformed send is retryable, never permanent; only a well-formed connector verdict or a refused config parks: `server/src/notifications/connector.ts`, `server/test/notifications.deliver.test.ts`.
- A result carries closed reasons only and neither the config nor the credential rides the event. The credential is a write-only body key stored in the secret store: the row holds only its reference and version, no read returns either, and `deliver` gets the value as its own argument, re-read on every send: `server/src/notifications/subscription-credential.ts`, `server/test-db/notification-subscriptions.routes.test.ts`.
- A credential read that is not a confirmed value of the stored version (refusal, throw, timeout, other version) settles `credential-unavailable`, retryable, never parked; a PUT without a credential keeps the stored one and a change of `connectorKind` needs a new one: `server/src/notifications/delivery-loop.ts`, `server/test-db/notification-outbox.test.ts`.
- Adding a channel is one connector file passed to `createConnectorRegistry`; `deliver` is bounded by the caller's signal, the outbox owns the deadline: `server/src/notifications/connector.ts`.
- A subscription's config and credential are whatever the registered connector's `validateConfig` / `validateCredential` returned; the production registry is `[discord]` and a kind outside it refuses `UNKNOWN_CONNECTOR`: `server/src/notifications/subscription-fields.ts`, `server/test-db/notification-subscriptions.routes.test.ts`.
- Discord sends only to a normalized `https://discord.com/api/webhooks/<id>/<token>` (discord.com and discordapp.com accepted, no other host, port, userinfo, query or fragment), never follows a redirect, sends `allowed_mentions: { parse: [] }` with every `@` in task text defused, and maps 401/403/404 and 400/413 to permanent, 429 and every other status to retryable: `server/src/notifications/discord.ts`, `server/test/notifications.discord.test.ts`.
- An event fans out to the enabled subscriptions matching it at emission, in the settle's transaction; a re-fired trigger for an existing event fans out nothing, a filtered subscription never matches a null repo/workflow: `server/migrations/104_notification_outbox.sql`, `server/test-db/notification-outbox.test.ts`.
- A send settles only under the lease token and on the store's injected clock; only `delivered` sets `delivered_at`, only a well-formed `permanent` or a subscription disabled after enqueue parks, and an unconfirmed read throws instead of parking: `server/src/notifications/outbox-store.ts`, `server/test-db/notification-outbox.test.ts`.
- The loop starts only with a registered connector and a public URL, releases every lease it takes, and bounds a pass by an absolute deadline: `server/src/notifications/delivery-loop.ts`, `server/test/notifications.delivery.test.ts`.
- Stated limits: the channel is not told when a question is answered or closed; delivery is at-least-once (a send in flight when a pod is lost, or ended `aborted`, may be re-sent); one webhook per subscription; a subscription only receives events emitted while it existed and was enabled; a pod lost between the credential's create and the row's insert leaves an orphan secret reported as `cleanup-failed`, and deleting an organization does not purge its subscriptions' secrets; one in-flight send may still reach a subscription disabled while its row is leased; re-enabling does not replay rows parked as `subscription-disabled`; a reopened thread does not re-notify; a batch task refused before its thread exists, a re-park on the same head and a wait that exhausts on its own do not notify.
