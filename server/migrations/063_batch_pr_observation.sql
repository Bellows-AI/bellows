-- Batch PR observation (issue #632): the board's durable view of each batch task's PR after the
-- run published it — state, head, target, checks, mergeability — read from GitHub, never inferred
-- from a run's failure_kind.
--
--   batch_pr_observation  one row per task, bound to (repo, PR number, attempt) at claim time.
--                 `outcome` is core's ObservationOutcome (null until the first assessment, and after
--                 a definitive read error withdrew it); `head_sha` is the revision the checks ran on
--                 and `target_sha` the one a conflict was judged against. `fingerprint` is the
--                 identity of what was assessed and `revision` counts its changes, so a refresh that
--                 finds nothing new bumps neither. `stale` is set by a webhook hint and cleared by
--                 the refresh it requested: a consumer must not act on a stale row. `hint_seq`
--                 counts hints, so a read that began before a hint cannot clear it.
--                 `error_code` is the last read failure (kept beside the last good assessment when
--                 transient); `failures` drives the backoff and resets on a success. `claim_token`
--                 and `claimed_until` lease a row to one reader, so two replicas, a duplicate event
--                 and a restart read once; a result is committed only while it still holds the lease.
--
-- A new attempt (a repair or retry) deletes the row in the scheduler's own transaction: old
-- failures are invalidated and fresh checks are awaited. This file must contain NO
-- `create extension`, per 005's header.

create table if not exists batch_pr_observation (
    org_id          text        not null,
    batch_id        uuid        not null,
    task_key        text        not null,
    repo            text        not null,
    pr_number       integer     not null check (pr_number > 0),
    attempt         integer     not null,
    revision        bigint      not null default 0,
    fingerprint     text,
    outcome         text,
    repairable      boolean     not null default false,
    pr_state        text,
    pr_url          text,
    base_branch     text,
    head_sha        text,
    target_sha      text,
    mergeability    text,
    checks          text,
    review          text,
    evidence        jsonb       not null default '[]'::jsonb,
    stale           boolean     not null default false,
    hint_seq        bigint      not null default 0,
    error_code     text,
    error_detail    text,
    failures        integer     not null default 0,
    observed_at     timestamptz,
    next_refresh_at timestamptz not null default now(),
    claim_token     uuid,
    claimed_until   timestamptz,
    updated_at      timestamptz not null default now(),
    constraint batch_pr_observation_pk primary key (org_id, batch_id, task_key),
    constraint batch_pr_observation_task_fk foreign key (org_id, batch_id, task_key)
        references batch_task (org_id, batch_id, key) on delete cascade,
    constraint batch_pr_observation_outcome_ck check (
        outcome is null or outcome in ('merged', 'closed_unmerged', 'checks_failing', 'conflicting',
                                       'checks_pending', 'checks_missing', 'review_required', 'unknown', 'ready')
    ),
    constraint batch_pr_observation_error_ck check (
        error_code is null or error_code in ('not_found', 'forbidden', 'rate_limited', 'transport', 'binding')
    ),
    -- Only an assessment of an open PR's own failure may be repaired.
    constraint batch_pr_observation_repairable_ck check (
        not repairable or outcome in ('checks_failing', 'conflicting')
    )
);

create index if not exists batch_pr_observation_due_idx on batch_pr_observation (org_id, next_refresh_at);
create index if not exists batch_pr_observation_pr_idx on batch_pr_observation (org_id, repo, pr_number);
