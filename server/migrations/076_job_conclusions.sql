-- Staged conclusions (issue #821): an attempt's final envelope, staged under its lease before the
-- driver completes and tears the attempt down. Immutable, one per attempt — keyed by the lease
-- token. The board commits it as the attempt's verdict when the lease expires before the driver's
-- complete lands, and refuses any other settle under that token, so a board outage after the
-- stage never re-runs or retires work that already finished.
--
--   claim_seq    the claim the attempt ran under, recorded on the interruption the commit appends.
--   fingerprint  sha256 of the canonical complete input — the settle receipt's, so the driver's
--                identical complete after a board commit replays the receipt.
--   result       the complete input itself, committed as the verdict.
--   policy       the evidence policy stamped on the row at the stage: the completion check reads
--                this snapshot, never a policy a later claim stamped.
--   reviewers    the reviewer profiles stamped on the row at the stage.
--
-- Removing a thread deletes its rows, and their staged conclusions with them.
--
-- This file must contain NO `create extension`, per 005's header.

create table if not exists job_conclusion (
    org_id      text not null,
    job_id      uuid not null,
    lease_token uuid not null,
    claim_seq   bigint not null,
    fingerprint text not null,
    result      jsonb not null,
    policy      jsonb,
    reviewers   jsonb,
    created_at  timestamptz not null default now(),
    primary key (org_id, job_id, lease_token),
    foreign key (org_id, job_id) references job (org_id, id) on delete cascade
);
