-- Batch executor scope: whose executor profile a plan's `executor` names (core's EXECUTOR_SCOPES).
--
--   batch.executor_scope       the plan's default as written; null when the plan names none.
--   batch_task.executor_scope  the task's as written while a draft, null when it names none; freeze
--                              resolves it beside a resolved `executor` (the task's, else the
--                              batch's, else `user`) and leaves it null beside none, and start
--                              refuses an executor left without one. Frozen with the rest of the
--                              plan, so every attempt of a task launches in the scope it started with.
--
-- 059's task freeze and 062's batch guard are redefined with the column added.
--
-- This file must contain NO `create extension`, per 005's header.

alter table batch add column if not exists executor_scope text;
alter table batch drop constraint if exists batch_executor_scope_ck;
alter table batch add constraint batch_executor_scope_ck check (
    executor_scope is null or executor_scope in ('user', 'org')
);

alter table batch_task add column if not exists executor_scope text;
alter table batch_task drop constraint if exists batch_task_executor_scope_ck;
alter table batch_task add constraint batch_task_executor_scope_ck check (
    executor_scope is null or executor_scope in ('user', 'org')
);

create or replace function batch_refuse_started_task() returns trigger
language plpgsql as $$
begin
    if tg_op = 'DELETE' then
        if batch_is_started(old.org_id, old.batch_id) then
            raise exception 'batch % is started: its plan is immutable', old.batch_id using errcode = '23514';
        end if;
        return old;
    end if;
    if tg_op = 'INSERT' then
        if batch_is_started(new.org_id, new.batch_id) then
            raise exception 'batch % is started: its plan is immutable', new.batch_id using errcode = '23514';
        end if;
        return new;
    end if;
    -- A task's thread is set once: retries and follow-ups stay rows of that thread. Only the thread's
    -- removal (the foreign key's set null) clears it.
    if old.root_job_id is not null and new.root_job_id is not null
       and new.root_job_id is distinct from old.root_job_id then
        raise exception 'task % of batch % already has a thread', new.key, new.batch_id using errcode = '23514';
    end if;
    if batch_is_started(new.org_id, new.batch_id) and (
        (new.key, new.stage_key, new.position, new.target_key, new.executor, new.executor_scope, new.objective,
         new.acceptance, new.verification, new.required, new.completion_kind, new.completion_condition)
        is distinct from
        (old.key, old.stage_key, old.position, old.target_key, old.executor, old.executor_scope, old.objective,
         old.acceptance, old.verification, old.required, old.completion_kind, old.completion_condition)
    ) then
        raise exception 'batch % is started: its plan is immutable', new.batch_id using errcode = '23514';
    end if;
    return new;
end $$;

create or replace function batch_guard() returns trigger
language plpgsql as $$
begin
    if old.status = 'started' and (
        (new.status, new.plan_version, new.title, new.default_target, new.executor, new.executor_scope,
         new.policy, new.concurrency, new.infra_retries, new.repairs, new.time_limit_minutes, new.deadline_at,
         new.version, new.started_at)
        is distinct from
        (old.status, old.plan_version, old.title, old.default_target, old.executor, old.executor_scope,
         old.policy, old.concurrency, old.infra_retries, old.repairs, old.time_limit_minutes, old.deadline_at,
         old.version, old.started_at)
    ) then
        raise exception 'batch % is started: its plan is immutable', old.id using errcode = '23514';
    end if;
    if old.status = 'draft' and new.status = 'started' and (
        exists (select 1 from batch_target
                where org_id = new.org_id and batch_id = new.id and branch is null)
        or exists (select 1 from batch_task
                   where org_id = new.org_id and batch_id = new.id
                     and (target_key is null or (executor is not null and executor_scope is null)))
        or exists (select 1 from batch_stage
                   where org_id = new.org_id and batch_id = new.id and policy is null)
    ) then
        raise exception 'batch % cannot start with an unresolved plan', old.id using errcode = '23514';
    end if;
    return new;
end $$;
