-- A claim's reservation of its candidate while it prepares (issue #822): the plan read runs outside
-- every lock, so the row is reserved for `CLAIM_PREPARE_SECONDS` and other claimers pass it by. A
-- successful acquisition clears it; a preparation that failed or was abandoned leaves it set — the
-- candidate's backoff — and the row queues as of its end: behind every candidate queued before
-- then, so healthy work progresses past a poison one however rarely the driver polls, and ahead of
-- every candidate queued after, so one failure never demotes it for good.
alter table job add column if not exists claim_deferred_until timestamptz;
