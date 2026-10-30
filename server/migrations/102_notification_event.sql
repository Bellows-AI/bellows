-- Notification events (BEL-128): the durable record that a task reached a verdict a person should hear about.
-- A deferred constraint trigger on job.status re-reads the row's FINAL status at commit and maps it:
-- succeeded -> task.ready, failed or dead -> task.blocked, anything else -> no event. The settle that writes the
-- status and the event commit together, and a rolled-back settle leaves neither. A policy refusal rewrites
-- succeeded -> failed inside one transaction, so it yields task.blocked only. BEL-133/134 narrow which rows
-- emit (this emits for every job row) and BEL-135 emits task.question. The event copies the raw command; the
-- title is derived only in core (core/src/task-title.ts). No FK to job: removing a task keeps its event.
-- Expand only (docs/persistence.md: a release only expands). This file must contain NO `create extension`, per
-- 005's header.

create table if not exists notification_event (
    org_id text not null,
    -- md5(job_id || '/' || kind): one event per (job, kind), whatever fires the trigger twice.
    id uuid not null,
    kind text not null check (kind in ('task.ready', 'task.blocked', 'task.question')),
    job_id uuid not null,
    root_job_id uuid not null,
    repo text,
    -- The job's frozen workflow_name (033), never a live lookup on workflow.
    workflow text,
    command text not null,
    -- failure_kind of a task.blocked; null otherwise.
    reason text,
    occurred_at timestamptz not null default now(),
    primary key (org_id, id)
);

create or replace function job_notification_event() returns trigger as $$
begin
    insert into notification_event (org_id, id, kind, job_id, root_job_id, repo, workflow, command, reason, occurred_at)
    select j.org_id,
           md5(j.id::text || '/' || e.kind)::uuid,
           e.kind,
           j.id,
           j.root_job_id,
           j.repo,
           j.workflow_name,
           j.command,
           j.failure_kind,
           coalesce(j.finished_at, now())
    from job j
    cross join lateral (
        select case j.status
                   when 'succeeded' then 'task.ready'
                   when 'failed' then 'task.blocked'
                   when 'dead' then 'task.blocked'
               end as kind
    ) e
    where j.org_id = new.org_id
      and j.id = new.id
      and e.kind is not null
    on conflict (org_id, id) do nothing;
    return null;
end;
$$ language plpgsql;

drop trigger if exists job_notification_event on job;
create constraint trigger job_notification_event
    after update of status on job
    deferrable initially deferred
    for each row
    when (old.status is distinct from new.status)
    execute function job_notification_event();
