-- The attempts the infrastructure interrupted (issue #792): a node drained under the driver, a
-- runner pod evicted. Each entry is one handed-back attempt — `at`, the driver's `reason` and the
-- `claimSeq` it ran under — appended by `POST /api/jobs/:id/interrupt`, oldest first. The array's
-- length is the job's interruption budget spent (`INTERRUPTION_BUDGET`): an interrupted attempt is
-- refunded, so it never spends a `max_attempts` slot the way a failed run does.
alter table job add column if not exists interruptions jsonb not null default '[]'::jsonb;
