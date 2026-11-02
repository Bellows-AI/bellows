-- The lease the current claim superseded, one claim back: a driver takeover rotates `lease_token`, and a runner
-- still presenting the pair it was handed must read as "retry with the current pair", not as a terminal refusal
-- (docs/connections.md). Set by a claim of a running row, cleared by a claim of a queued one; only ever compared
-- by server/src/db/attempt-of-lease.ts, never returned. This file must contain NO `create extension`, per 005's header.

alter table job add column if not exists prior_lease_token uuid;
