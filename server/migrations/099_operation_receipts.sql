-- Operation receipts (BEL-61): the durable record of one runner-side write to an external provider, keyed by the
-- logical operation the runner means (a hash of what it is about to do, or a key it chose). It exists so a lost
-- response is settled by what the receipt says, never by a replay: `started` was never dispatched, `dispatched`
-- may have run, `unknown` is a dispatched write whose outcome could not be confirmed. Expand only
-- (docs/persistence.md: a release only expands). This file must contain NO `create extension`, per 005's header.

create table if not exists integration_operation_receipt (
    id uuid primary key default gen_random_uuid(),
    org_id text not null,
    root_job_id uuid not null,
    connection_id uuid,
    provider text not null,
    operation text not null,
    operation_key text not null check (operation_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
    fingerprint text not null,
    status text not null default 'started' check (status in ('started', 'dispatched', 'succeeded', 'failed', 'unknown')),
    -- Closed: {"commentId": "<digits>"} only, never a provider's body.
    result jsonb,
    -- The attempt row that last wrote the receipt.
    job_id uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    dispatched_at timestamptz,
    constraint integration_operation_receipt_root_fk foreign key (org_id, root_job_id)
        references job (org_id, id) on delete cascade
);

create unique index if not exists integration_operation_receipt_key_uk
    on integration_operation_receipt (org_id, root_job_id, operation_key);
