-- Batch runtime (issue #579): what dispatch writes against a started batch's frozen plan.
--
--   batch.cancelled_at / completed_at   the lifecycle's two terminal stamps; `status` stays
--                 'started' (059's check), so a cancelled or finished batch is still a started one.
--   batch_attempt one row per launch of a task's thread: attempt 1 is the root job, every retry or
--                 repair is a further job of the SAME thread. Records the repository, the frozen
--                 target branch and, when the board could resolve it, the source revision.
--   batch_decision  one row per scheduling decision, unique by `key` (`launch:<task>:<attempt>`,
--                 `advance:<stage>`, `complete`, `cancel`). Inserted `on conflict do nothing` under
--                 the batch's row lock, so a duplicate event or a second scheduler process finds
--                 the decision already made and does nothing. The active stage is the first one
--                 without an `advance` decision: batch_stage itself is immutable once started.
--
-- This file must contain NO `create extension`, per 005's header.

alter table batch
    add column if not exists cancelled_at timestamptz,
    add column if not exists cancelled_by uuid references app_user (id) on delete set null,
    add column if not exists completed_at timestamptz;

create table if not exists batch_attempt (
    org_id          text not null,
    batch_id        uuid not null,
    task_key        text not null,
    attempt         int  not null,
    kind            text not null,
    job_id          uuid,
    repo            text not null,
    source_branch   text not null,
    source_revision text,
    created_at      timestamptz not null default now(),
    constraint batch_attempt_pk primary key (org_id, batch_id, task_key, attempt),
    constraint batch_attempt_kind_ck check (kind in ('launch', 'retry')),
    constraint batch_attempt_task_fk foreign key (org_id, batch_id, task_key)
        references batch_task (org_id, batch_id, key) on delete cascade,
    -- A removed thread deletes its job rows; the attempt stays as history.
    constraint batch_attempt_job_fk foreign key (org_id, job_id) references job (org_id, id)
        on delete set null (job_id)
);

create table if not exists batch_decision (
    org_id     text not null,
    batch_id   uuid not null,
    key        text not null,
    kind       text not null,
    subject    text,
    decided_at timestamptz not null default now(),
    constraint batch_decision_pk primary key (org_id, batch_id, key),
    constraint batch_decision_kind_ck check (kind in ('launch', 'advance', 'complete', 'cancel')),
    constraint batch_decision_batch_fk foreign key (org_id, batch_id) references batch (org_id, id) on delete cascade
);

-- The reconcile pass reads started, unfinished batches.
create index if not exists batch_open_idx on batch (org_id, id)
    where status = 'started' and completed_at is null;
