-- Every lease token the task gave up while it may still run: a claim of a running row appends the lease it
-- supersedes, and a drained driver's hand-back (the release-interrupt) appends the lease it clears before the row
-- goes back to `queued`. A runner still presenting any of them, on a task that has not ended, must read as "retry
-- with the current pair", not as a terminal refusal (docs/connections.md). Append-only and never cleared: a task
-- holds few leases, and `running -> queued` is reachable only by that hand-back (084). Only ever compared by
-- server/src/db/attempt-of-lease.ts and server/src/db/agent-title.ts, never returned. A constant default adds the
-- column without a table rewrite. This file must contain NO `create extension`, per 005's header.

alter table job add column if not exists superseded_lease_tokens uuid[] not null default '{}'::uuid[];
