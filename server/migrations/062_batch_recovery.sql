-- Batch recovery (issue #581): the budgets the plan freezes and the state bounded recovery writes.
--
--   batch.infra_retries / repairs / time_limit_minutes   the plan's recovery budgets, frozen at
--                 start with the rest of the plan (core's constants are the authority; the column
--                 defaults only fill rows that predate this file). `deadline_at` is `started_at`
--                 plus the limit, set by start and frozen too; `expired_at` is the third terminal
--                 stamp beside 060's cancelled_at/completed_at, written once by the pass that finds
--                 the deadline passed. An expired batch dispatches and advances nothing.
--   batch_task.attention   why the task needs a person (core's ATTENTION_REASONS), null otherwise.
--   batch_task.recovery / not_before   a queued automatic recovery and, for an infrastructure
--                 retry, the instant its backoff ends.
--   batch_attempt.kind     adds 'infra_retry' and 'repair'. The budgets are COUNTED from these rows,
--                 so a restart cannot reset a budget or repeat a recovery.
--   batch_decision.kind    adds 'expire'.
--
-- This file must contain NO `create extension`, per 005's header.

alter table batch
    add column if not exists infra_retries int not null default 2,
    add column if not exists repairs int not null default 2,
    add column if not exists time_limit_minutes int not null default 720,
    add column if not exists deadline_at timestamptz,
    add column if not exists expired_at timestamptz;

update batch set deadline_at = started_at + make_interval(mins => time_limit_minutes)
where status = 'started' and deadline_at is null;

alter table batch drop constraint if exists batch_deadline_ck;
alter table batch add constraint batch_deadline_ck check ((status = 'started') = (deadline_at is not null));

alter table batch_task
    add column if not exists attention text,
    add column if not exists recovery text,
    add column if not exists not_before timestamptz;

alter table batch_task drop constraint if exists batch_task_attention_ck;
alter table batch_task add constraint batch_task_attention_ck check (
    attention is null
    or attention in ('configuration', 'blocked', 'question', 'budget', 'refused', 'unclassified')
);
alter table batch_task drop constraint if exists batch_task_recovery_ck;
alter table batch_task add constraint batch_task_recovery_ck check (
    recovery is null or recovery in ('infra_retry', 'repair')
);

alter table batch_attempt drop constraint if exists batch_attempt_kind_ck;
alter table batch_attempt add constraint batch_attempt_kind_ck check (
    kind in ('launch', 'retry', 'infra_retry', 'repair')
);

alter table batch_decision drop constraint if exists batch_decision_kind_ck;
alter table batch_decision add constraint batch_decision_kind_ck check (
    kind in ('launch', 'advance', 'complete', 'cancel', 'expire')
);

-- 059's guard with the budgets and the deadline added to the frozen plan.
create or replace function batch_guard() returns trigger
language plpgsql as $$
begin
    if old.status = 'started' and (
        (new.status, new.plan_version, new.title, new.default_target, new.executor, new.policy,
         new.concurrency, new.infra_retries, new.repairs, new.time_limit_minutes, new.deadline_at,
         new.version, new.started_at)
        is distinct from
        (old.status, old.plan_version, old.title, old.default_target, old.executor, old.policy,
         old.concurrency, old.infra_retries, old.repairs, old.time_limit_minutes, old.deadline_at,
         old.version, old.started_at)
    ) then
        raise exception 'batch % is started: its plan is immutable', old.id using errcode = '23514';
    end if;
    if old.status = 'draft' and new.status = 'started' and (
        exists (select 1 from batch_target
                where org_id = new.org_id and batch_id = new.id and branch is null)
        or exists (select 1 from batch_task
                   where org_id = new.org_id and batch_id = new.id and target_key is null)
        or exists (select 1 from batch_stage
                   where org_id = new.org_id and batch_id = new.id and policy is null)
    ) then
        raise exception 'batch % cannot start with an unresolved plan', old.id using errcode = '23514';
    end if;
    return new;
end $$;
