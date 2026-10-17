-- Durable settle receipts (issue #821). An attempt's conclusion — complete, suspend, requeue or a
-- released interrupt — records the answer it gave in the settle's own transaction, keyed by the
-- attempt's lease token: one conclusion per attempt. The identical request replayed after its
-- response was lost (same operation, same fingerprint) answers the stored result; any other
-- request under that token is refused as a lost lease, exactly as before.
--
--   operation    which settle concluded the attempt.
--   fingerprint  sha256 of the canonical store input, so a different request is never replayed.
--   result       the answer the settle returned.
--
-- Removing a thread deletes its rows, and their receipts with them.
--
-- This file must contain NO `create extension`, per 005's header.

create table if not exists job_settle_receipt (
    org_id      text not null,
    job_id      uuid not null,
    lease_token uuid not null,
    operation   text not null check (operation in ('complete', 'suspend', 'requeue', 'interrupt')),
    fingerprint text not null,
    result      jsonb not null,
    created_at  timestamptz not null default now(),
    primary key (org_id, job_id, lease_token),
    foreign key (org_id, job_id) references job (org_id, id) on delete cascade
);
