-- Execution provenance (issue #845, epic #842): one row per claim, written in the claim's own
-- transaction, that outlives the operational job it describes. Minimal attribution only — opaque
-- ids, a repository label and two identities; never a prompt, a credential or profile data.
--
--   job_execution          the claim: whose it was (org, author, repo), where it sits (job, task root,
--                          the requesting job and its root for a named review), and which executor
--                          configuration ran it. `executor` is the configuration identity the job
--                          carries; `agent` is the telemetry identity, null until a report names it.
--   launch                 what the board knows of the process: `requested` is all a committed
--                          transaction can prove. observed | refused | unknown | adopted only ever
--                          follow it, forward only (`job_execution_launch_forward`): requested moves to any
--                          of them, unknown to observed (late evidence), nothing else moves. `adopts_claim_seq`
--                          links an adopting claim to the original, always an earlier claim, and exactly
--                          the adopted rows carry one. A claim the board gives up on (its job leaves
--                          `running`, or a later claim supersedes it) without launch evidence becomes
--                          `unknown`, never `observed` or `refused`: `job_execution_give_up`.
--   created_at, ended_at   the claim's half-open window [created_at, ended_at): the claim start, and the
--                          instant the board stopped treating it as the live claim, written once with the
--                          operation that ends it (job_execution_give_up). Null is open or unknown, never
--                          inferred from wall-clock totals.
--   resumed                the claim handed the runner a retained session (recovery or follow-up).
--   job_execution_session  the sessions an execution is associated with. `inferred_at_claim` is the
--                          board's inference from the retained pointer, not a driver report.
--
-- No foreign key to job or app_user: removing a task or a person never cascades into provenance
-- (`removed_at` marks the operational row's removal).
--
-- This file must contain NO `create extension`, per 005's header.

create table if not exists job_execution (
    org_id               text        not null,
    job_id               uuid        not null,
    claim_seq            bigint      not null,
    root_job_id          uuid        not null,
    requesting_job_id    uuid,
    requesting_root_job_id uuid,
    author_id            uuid,
    repo                 text,
    executor             text,
    executor_scope       text,
    agent                text,
    launch               text        not null default 'requested'
                         check (launch in ('requested', 'observed', 'refused', 'unknown', 'adopted')),
    adopts_claim_seq     bigint,
    resumed              boolean     not null default false,
    origin               text        not null default 'claim' check (origin in ('claim', 'backfill')),
    removed_at           timestamptz,
    created_at           timestamptz not null default now(),
    ended_at             timestamptz,
    updated_at           timestamptz not null default now(),
    primary key (org_id, job_id, claim_seq),
    constraint job_execution_ended_after_start check (ended_at is null or ended_at >= created_at),
    constraint job_execution_adopts_earlier check (adopts_claim_seq is null or adopts_claim_seq < claim_seq),
    constraint job_execution_adopted_link check ((launch = 'adopted') = (adopts_claim_seq is not null))
);

create index if not exists job_execution_root on job_execution (org_id, root_job_id);

create table if not exists job_execution_session (
    org_id        text        not null,
    job_id        uuid        not null,
    claim_seq     bigint      not null,
    session_id    text        not null,
    agent         text,
    origin        text        not null check (origin in ('inferred_at_claim', 'reported', 'backfill')),
    first_seen_at timestamptz not null default now(),
    last_seen_at  timestamptz not null default now(),
    primary key (org_id, job_id, claim_seq, session_id),
    foreign key (org_id, job_id, claim_seq) references job_execution (org_id, job_id, claim_seq)
);

create index if not exists job_execution_session_by_session on job_execution_session (org_id, session_id);

create or replace function job_execution_launch_forward() returns trigger
language plpgsql as $$
begin
    if old.adopts_claim_seq is not null and new.adopts_claim_seq is distinct from old.adopts_claim_seq then
        raise exception 'job_execution %/%: the adopted claim link is set once', old.job_id, old.claim_seq
            using errcode = '23514', constraint = 'job_execution_launch_transition';
    end if;
    if old.ended_at is not null and new.ended_at is distinct from old.ended_at then
        raise exception 'job_execution %/%: the end of a claim is written once', old.job_id, old.claim_seq
            using errcode = '23514', constraint = 'job_execution_launch_transition';
    end if;
    if old.launch = new.launch
       or (old.launch, new.launch) in (
           ('requested', 'observed'), ('requested', 'refused'), ('requested', 'unknown'),
           ('requested', 'adopted'), ('unknown', 'observed')
       ) then
        return new;
    end if;
    raise exception 'job_execution %/%: launch % -> % is not a forward move', old.job_id, old.claim_seq, old.launch, new.launch
        using errcode = '23514', constraint = 'job_execution_launch_transition';
end $$;

drop trigger if exists job_execution_launch_forward on job_execution;
create trigger job_execution_launch_forward before update of launch, adopts_claim_seq, ended_at on job_execution
    for each row execute function job_execution_launch_forward();

-- The board gave up on a claim with nothing proving the process started: its job left `running`
-- (released, stopped, settled, retired) or a later claim superseded it (a lost lease, an adopter).
-- Written by the same statement that moves the job, so no path can forget it. The claim's end is
-- stamped once; only a `requested` launch moves, to `unknown`: a refusal, an adoption or observed
-- evidence recorded first stays.
create or replace function job_execution_give_up() returns trigger
language plpgsql as $$
begin
    update job_execution
    set launch = case when launch = 'requested' then 'unknown' else launch end,
        ended_at = now(), updated_at = now()
    where org_id = new.org_id and job_id = new.id and ended_at is null
      and (claim_seq < new.claim_seq
           or (claim_seq = old.claim_seq and old.status = 'running' and new.status <> 'running'));
    return null;
end $$;

drop trigger if exists job_execution_give_up on job;
create trigger job_execution_give_up after update of status, claim_seq on job
    for each row when (old.status is distinct from new.status or old.claim_seq is distinct from new.claim_seq)
    execute function job_execution_give_up();
