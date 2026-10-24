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
--                          follow it. `adopts_claim_seq` links an adopting claim to the original.
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
    updated_at           timestamptz not null default now(),
    primary key (org_id, job_id, claim_seq)
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
