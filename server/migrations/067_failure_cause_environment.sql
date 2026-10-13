-- A gate that failed for the environment, not the change (issue #653).
--
--   job.failure_cause  gains `environment`: every test passed but the gate exited non-zero, or the
--                      gate timed out or was killed. The batch scheduler retries it as
--                      infrastructure instead of sending it to an agent as a code problem.
--
-- This file must contain NO `create extension`, per 005's header.

alter table job drop constraint if exists job_failure_cause_ck;
alter table job add constraint job_failure_cause_ck check (
    failure_cause is null
    or failure_cause in ('verification', 'conflict', 'denied', 'config', 'transport', 'environment', 'unknown')
);
