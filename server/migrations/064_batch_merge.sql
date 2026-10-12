-- Batch protected automerge and verified stage progression (issue #633).
--
--   batch_merge  one row per merge intent: the board's decision to ask GitHub to merge one task's
--                PR, with the observation it was made on (`observation_revision`, `head_sha`,
--                `target_sha`). `state` is core's MergeState. `dispatching` and `uncertain` hold the
--                repository/target's one merge slot (the partial unique index), so two batches
--                competing for a branch merge one at a time and an unresolved request blocks the
--                next until it is reconciled against the PR. The (task, attempt, revision) triple is
--                unique among intents that were not `lapsed` or `changed` (both retry after `retry_at`): the same observation is never
--                requested twice, a new revision may be, and a lapsed request (never accepted by the
--                provider) may be tried again after `retry_at`. `lease_until` bounds a dispatch: a
--                process that dies mid-request leaves a row the next pass treats as uncertain.
--   batch_stage_verification  the combined verification of an automerge stage after its merges:
--                the target tip, its checks and the merge commits it must contain. A stage advances
--                only on `passed`; the row is re-read until it is, and never rewritten once it is.
--
-- This file must contain NO `create extension`, per 005's header.

create table if not exists batch_merge (
    id                   bigint generated always as identity primary key,
    org_id               text        not null,
    batch_id             uuid        not null,
    task_key             text        not null,
    attempt              integer     not null,
    observation_revision bigint      not null,
    repo                 text        not null,
    pr_number            integer     not null check (pr_number > 0),
    target_branch        text        not null,
    head_sha             text        not null,
    target_sha           text,
    method               text        not null,
    state                text        not null,
    merge_commit_sha     text,
    detail               text,
    retry_at             timestamptz,
    lease_until          timestamptz,
    created_at           timestamptz not null default now(),
    resolved_at          timestamptz,
    constraint batch_merge_task_fk foreign key (org_id, batch_id, task_key)
        references batch_task (org_id, batch_id, key) on delete cascade,
    constraint batch_merge_state_ck check (
        state in ('dispatching', 'uncertain', 'merged', 'refused', 'changed', 'fenced', 'lapsed')
    )
);

create unique index if not exists batch_merge_observation_idx
    on batch_merge (org_id, batch_id, task_key, attempt, observation_revision)
    where state not in ('lapsed', 'changed');

create unique index if not exists batch_merge_slot_idx
    on batch_merge (org_id, lower(repo), target_branch)
    where state in ('dispatching', 'uncertain');

create index if not exists batch_merge_task_idx on batch_merge (org_id, batch_id, task_key, attempt);

create table if not exists batch_stage_verification (
    org_id        text        not null,
    batch_id      uuid        not null,
    stage_key     text        not null,
    state         text        not null,
    head_sha      text,
    detail        text,
    checked_at    timestamptz not null default now(),
    next_check_at timestamptz not null default now(),
    constraint batch_stage_verification_pk primary key (org_id, batch_id, stage_key),
    constraint batch_stage_verification_stage_fk foreign key (org_id, batch_id, stage_key)
        references batch_stage (org_id, batch_id, key) on delete cascade,
    constraint batch_stage_verification_state_ck check (state in ('passed', 'pending', 'failed', 'unknown'))
);
