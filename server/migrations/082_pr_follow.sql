-- The PR follower's cadence (issue #831): the periodic read that makes the webhook-only paths — a
-- parked block wait on a PR, and the merged-PR close of a non-batch thread — converge when a
-- delivery is lost. One row per followed (org, repo, PR): WHEN it is next read, never WHAT it said.
-- Everything it concludes is applied to the existing wait, ledger and thread rows, so the row can
-- be deleted at any time and rebuilt from them.
--
--   next_poll_at  when the PR is next due; a new row is spread over the interval so an existing
--                 backlog does not read at once.
--   claim_token   a reader leases the row while it reads GitHub, so two replicas, a restart and
--   claimed_until a duplicate tick read once; a result is committed only while the lease stands.
--   failures      drives the backoff and resets on a success; error_code is the last failure.
--
-- A followed PR is read for as long as a wait or a live thread follows it, at a slower cadence once
-- seen closed: a reopen and merge with every webhook lost must still close the thread.
--
-- workflow_wait.observed_fingerprint identifies WHAT the follower last observed for THAT wait (a hash
-- of the PR facts the read returns), not only when: a read that differs from it folds, an identical
-- one never does, and it survives the wait being entered again so activity during a continuation
-- still wakes the re-parked wait. Null until the wait's first observation.
--
-- This file must contain NO `create extension`, per 005's header.

create table if not exists pr_follow (
    org_id        text        not null,
    repo          text        not null check (char_length(repo) between 3 and 201),
    pr_number     integer     not null check (pr_number > 0),
    next_poll_at  timestamptz not null default now(),
    claim_token   uuid,
    claimed_until timestamptz,
    failures      integer     not null default 0,
    error_code    text        check (error_code is null or error_code in
                                     ('not_found', 'forbidden', 'rate_limited', 'transport', 'binding')),
    observed_at   timestamptz,
    updated_at    timestamptz not null default now(),

    constraint pr_follow_pk primary key (org_id, repo, pr_number),
    constraint pr_follow_org_fk foreign key (org_id)
        references organization (id) on update cascade on delete cascade
);

create index if not exists pr_follow_due_idx on pr_follow (org_id, next_poll_at);

alter table workflow_wait add column if not exists observed_fingerprint text;

-- workflow_wait.observed_since is the instant up to which the wait's thread has taken the PR into
-- account: the wait's first entry, advanced by every fold (webhook or follower) and every claim of
-- its deliveries (the wake sweep and the poke), and untouched by re-entry. A first observation
-- wakes the wait only for activity not before it. A wait that exists before this migration takes
-- its first entry, so activity that happened while no follower read it still wakes it (a duplicate
-- wake is the accepted cost).
alter table workflow_wait add column if not exists observed_since timestamptz;
update workflow_wait set observed_since = created_at where observed_since is null;
alter table workflow_wait alter column observed_since set default now();
alter table workflow_wait alter column observed_since set not null;
