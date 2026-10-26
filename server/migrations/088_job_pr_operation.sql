-- PR operations (issue #983): one row per managed publish operation of a job, written by the driver
-- under its lease at the moment the operation ran — never derived from a verdict afterwards.
--
--   operation_id  minted by the driver per operation; the replay key. A retried write or a replayed
--                 verdict adds nothing, two genuine operations on one PR are two rows.
--   claim_seq     the claim of the driver that wrote the row.
--   operation     `created`: the driver opened the PR. `reused`: it found one (an earlier publish, the
--                 agent's, or a create whose answer was lost). There is no agent value: an agent-created
--                 PR is attributed later, from the transcript.
-- Removing a thread deletes its rows.
--
-- This file must contain NO `create extension`, per 005's header.

create table if not exists job_pr_operation (
    org_id       text        not null,
    job_id       uuid        not null,
    operation_id uuid        not null,
    claim_seq    bigint      not null,
    operation    text        not null check (operation in ('created', 'reused')),
    repo         text        not null,
    pr_number    integer     not null check (pr_number > 0),
    pr_url       text        not null,
    branch       text        not null,
    created_at   timestamptz not null default now(),
    primary key (org_id, job_id, operation_id),
    foreign key (org_id, job_id) references job (org_id, id) on delete cascade
);
