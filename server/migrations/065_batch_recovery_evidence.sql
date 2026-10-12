-- Batch recovery by evidence (issue #581).
--
--   job.failure_cause  what lies under a `gate`, `publish` or `helper` failure, as the driver
--                      classified it: `verification`, `conflict`, `denied`, `config`, `transport`
--                      or `unknown`. Null on every other kind and on a success. The batch
--                      scheduler recovers by it; the route refuses it under any other kind.
--   batch_decision     gains `repair`: a repair decided from an observed PR (a failing check or a
--                      conflict after a successful run), unique per task, attempt and revision.
--   batch_task         attention gains `closed`: the task's PR was closed without merging.
--
-- This file must contain NO `create extension`, per 005's header.

alter table job add column if not exists failure_cause text;
alter table job drop constraint if exists job_failure_cause_ck;
alter table job add constraint job_failure_cause_ck check (
    failure_cause is null
    or failure_cause in ('verification', 'conflict', 'denied', 'config', 'transport', 'unknown')
);

alter table batch_decision drop constraint if exists batch_decision_kind_ck;
alter table batch_decision add constraint batch_decision_kind_ck check (
    kind in ('launch', 'advance', 'complete', 'cancel', 'expire', 'repair')
);

alter table batch_task drop constraint if exists batch_task_attention_ck;
alter table batch_task add constraint batch_task_attention_ck check (
    attention is null
    or attention in ('configuration', 'blocked', 'question', 'budget', 'refused', 'unclassified', 'closed')
);
