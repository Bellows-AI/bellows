-- A person force-closes a live batch's thread (issue #676).
--
--   batch_task.closed_at  when a person closed the task's thread while its batch was live: the
--                         task is cancelled (unless already accepted), never retried or repaired,
--                         and the scheduler marks its thread done once its head settles.
--   batch_task.closed_by  who closed it; null without a signed-in person (AUTH_MODE=none).
--
-- Both are runtime columns: 059's immutability trigger lists the plan columns it refuses, not these.
--
-- This file must contain NO `create extension`, per 005's header.

alter table batch_task
    add column if not exists closed_at timestamptz,
    add column if not exists closed_by uuid references app_user (id) on delete set null;

-- batch.threads_closed_at: stamped by the first pass that finds an ended batch (completed, cancelled
-- or expired) with every task thread done. The reconcile sweep reads only batches without it, so a
-- finished batch is scanned until its threads close and never again.
alter table batch add column if not exists threads_closed_at timestamptz;

create index if not exists batch_unclosed_idx on batch (org_id, started_at, id)
    where status = 'started' and threads_closed_at is null;
