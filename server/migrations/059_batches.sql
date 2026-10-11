-- Batches (issue #578): an ordered plan of stages of parallel tasks across one or more repository
-- targets. A batch is a DRAFT until it is started; start freezes the resolved plan into the same
-- rows and queues no work (dispatch is #579, PR binding and merges #580).
--
--   batch         the plan's settings and its lifecycle: `version` is bumped by every draft write, and
--                 both the whole-draft replace and the freeze are conditional on it.
--   batch_target  repository targets. No uniqueness on `repo` and no single-target constraint: the
--                 schema never encodes today's runtime limit (batchExecutionCapability does).
--   batch_stage   ordered by `position`; order is the only dependency model.
--   batch_task    one logical task. `target_key` is a composite foreign key into THIS batch's
--                 targets, so a cross-batch or cross-org target is unrepresentable. `root_job_id`
--                 binds the task to the thread that works it: one thread backs at most one task.
--                 `execution`/`pr`/`gate`/`wait_reason` are the read model's state fields; this
--                 migration declares them and their initial values, later issues add transitions.
--   batch_idempotency  Idempotency-Key records for create and start, scoped like job's (org,
--                 caller, operation, key).
--
-- A started batch's plan rows are immutable: the triggers below refuse any write to a plan column
-- once the parent is `started`. The runtime columns of batch_task stay writable. Freeze resolves
-- an explicit branch per target, a target per task and a policy per stage, and the
-- start trigger refuses a batch that reaches `started` with any of them unresolved.
--
-- This file must contain NO `create extension`, per 005's header.

create table if not exists batch (
    org_id         text not null references organization (id) on update cascade on delete cascade,
    id             uuid not null default gen_random_uuid(),
    status         text not null default 'draft',
    version        int  not null default 1,
    plan_version   int  not null,
    title          text not null,
    default_target text,
    executor       text,
    policy         text not null,
    concurrency    int  not null,
    created_by     uuid references app_user (id) on delete set null,
    started_by     uuid references app_user (id) on delete set null,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    started_at     timestamptz,
    constraint batch_pk primary key (org_id, id),
    constraint batch_status_ck check (status in ('draft', 'started')),
    constraint batch_policy_ck check (policy in ('automerge', 'human')),
    constraint batch_started_ck check ((status = 'started') = (started_at is not null))
);

create index if not exists batch_list_idx on batch (org_id, created_at desc, id);

create table if not exists batch_target (
    org_id   text not null,
    batch_id uuid not null,
    key      text not null,
    position int  not null,
    repo     text not null,
    branch   text,
    constraint batch_target_pk primary key (org_id, batch_id, key),
    constraint batch_target_batch_fk foreign key (org_id, batch_id) references batch (org_id, id) on delete cascade
);

create table if not exists batch_stage (
    org_id   text not null,
    batch_id uuid not null,
    key      text not null,
    position int  not null,
    policy   text,
    constraint batch_stage_pk primary key (org_id, batch_id, key),
    constraint batch_stage_position_uk unique (org_id, batch_id, position),
    constraint batch_stage_policy_ck check (policy in ('automerge', 'human')),
    constraint batch_stage_batch_fk foreign key (org_id, batch_id) references batch (org_id, id) on delete cascade
);

create table if not exists batch_task (
    org_id               text not null,
    batch_id             uuid not null,
    key                  text not null,
    stage_key            text not null,
    position             int  not null,
    target_key           text,
    executor             text,
    objective            text not null,
    acceptance           text not null,
    verification         text not null,
    required             boolean not null default true,
    completion_kind      text not null default 'pr',
    completion_condition text,
    root_job_id          uuid,
    execution            text not null default 'pending',
    pr                   text not null default 'none',
    gate                 text not null default 'open',
    wait_reason          text,
    constraint batch_task_pk primary key (org_id, batch_id, key),
    constraint batch_task_stage_fk foreign key (org_id, batch_id, stage_key)
        references batch_stage (org_id, batch_id, key) on delete cascade,
    constraint batch_task_target_fk foreign key (org_id, batch_id, target_key)
        references batch_target (org_id, batch_id, key),
    -- Removing a thread deletes its job rows; the task survives it, unbound.
    constraint batch_task_root_fk foreign key (org_id, root_job_id) references job (org_id, id)
        on delete set null (root_job_id),
    constraint batch_task_root_uk unique (org_id, root_job_id),
    constraint batch_task_completion_ck check (
        (completion_kind = 'pr' and completion_condition is null)
        or (completion_kind = 'accepted' and completion_condition is not null)
    )
);

create table if not exists batch_idempotency (
    org_id      text not null,
    caller      text not null,
    operation   text not null,
    key         text not null,
    fingerprint text not null,
    batch_id    uuid not null,
    recorded_at timestamptz not null default now(),
    constraint batch_idempotency_pk primary key (org_id, caller, operation, key),
    constraint batch_idempotency_batch_fk foreign key (org_id, batch_id) references batch (org_id, id) on delete cascade
);

-- The parent's status, read by the child triggers. Null once the parent is gone (a cascade delete),
-- which is why the child triggers let a delete through then.
create or replace function batch_is_started(p_org text, p_batch uuid) returns boolean
language sql stable as $$
    select status = 'started' from batch where org_id = p_org and id = p_batch
$$;

create or replace function batch_refuse_started_target() returns trigger
language plpgsql as $$
begin
    if tg_op = 'DELETE' then
        if batch_is_started(old.org_id, old.batch_id) then
            raise exception 'batch % is started: its plan is immutable', old.batch_id using errcode = '23514';
        end if;
        return old;
    end if;
    if batch_is_started(new.org_id, new.batch_id) then
        raise exception 'batch % is started: its plan is immutable', new.batch_id using errcode = '23514';
    end if;
    return new;
end $$;

create or replace function batch_refuse_started_stage() returns trigger
language plpgsql as $$
begin
    if tg_op = 'DELETE' then
        if batch_is_started(old.org_id, old.batch_id) then
            raise exception 'batch % is started: its plan is immutable', old.batch_id using errcode = '23514';
        end if;
        return old;
    end if;
    if batch_is_started(new.org_id, new.batch_id) then
        raise exception 'batch % is started: its plan is immutable', new.batch_id using errcode = '23514';
    end if;
    return new;
end $$;

-- A task's plan columns are frozen with the batch; root_job_id (set once), execution, pr, gate and
-- wait_reason are the runtime and stay writable.
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
        (new.key, new.stage_key, new.position, new.target_key, new.executor, new.objective, new.acceptance,
         new.verification, new.required, new.completion_kind, new.completion_condition)
        is distinct from
        (old.key, old.stage_key, old.position, old.target_key, old.executor, old.objective, old.acceptance,
         old.verification, old.required, old.completion_kind, old.completion_condition)
    ) then
        raise exception 'batch % is started: its plan is immutable', new.batch_id using errcode = '23514';
    end if;
    return new;
end $$;

create or replace function batch_guard() returns trigger
language plpgsql as $$
begin
    if old.status = 'started' and (
        (new.status, new.plan_version, new.title, new.default_target, new.executor, new.policy,
         new.concurrency, new.version, new.started_at)
        is distinct from
        (old.status, old.plan_version, old.title, old.default_target, old.executor, old.policy,
         old.concurrency, old.version, old.started_at)
    ) then
        raise exception 'batch % is started: its plan is immutable', old.id using errcode = '23514';
    end if;
    -- Reaching `started` requires the plan resolved: a branch per target, a target and a policy
    -- everywhere they are read.
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

drop trigger if exists batch_target_immutable on batch_target;
create trigger batch_target_immutable before insert or update or delete on batch_target
    for each row execute function batch_refuse_started_target();

drop trigger if exists batch_stage_immutable on batch_stage;
create trigger batch_stage_immutable before insert or update or delete on batch_stage
    for each row execute function batch_refuse_started_stage();

drop trigger if exists batch_task_immutable on batch_task;
create trigger batch_task_immutable before insert or update or delete on batch_task
    for each row execute function batch_refuse_started_task();

drop trigger if exists batch_immutable on batch;
create trigger batch_immutable before update on batch
    for each row execute function batch_guard();
