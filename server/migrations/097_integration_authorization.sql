-- Outbound OAuth authorization transactions (BEL-138): one row per person-initiated connect or reconnect, from the
-- authorize URL to the activated connection. Expand only (docs/persistence.md): a new table, no existing writer.
--
-- The state itself is never stored, only its hash; the PKCE verifier is nulled the moment the row is consumed. A row
-- is consumed once (`pending` -> `exchanging`), so a replayed callback exchanges nothing. `persisting` carries the
-- pre-allocated grant and secret reference with the SecretStore operation ID, so a lost holder is reconciled instead of
-- exchanged again. `deadline_at` is the durable end of the flow, so recovery never fails a live holder. `result`
-- holds non-secret facts only: account, resources, authority, connection IDs.
--
-- This file must contain NO `create extension`, per 005's header.

create table if not exists integration_authorization (
    id uuid primary key default gen_random_uuid(),
    org_id text not null references organization (id) on update cascade on delete cascade,
    user_id uuid not null references app_user (id) on delete cascade,
    provider text not null,
    intent text not null check (intent in ('connect', 'reconnect')),
    connection_id uuid references connector_connection (id) on delete cascade,
    grant_id uuid,
    grant_claim uuid,
    expected_account_id text,
    -- Opaque until BEL-140: no foreign key, never used for authorization.
    interaction_id uuid,
    state_hash text not null unique,
    pkce_verifier text,
    return_to text not null,
    status text not null default 'pending'
        check (status in ('pending', 'exchanging', 'persisting', 'completed', 'failed', 'expired')),
    failure text check (failure in (
        'denied', 'state-mismatch', 'identity-mismatch', 'grant-conflict', 'duplicate-connection',
        'exchange-failed', 'storage-failed', 'busy', 'expired', 'interrupted'
    )),
    pending_grant_id uuid,
    secret_ref text,
    secret_operation_id text,
    result jsonb,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    consumed_at timestamptz,
    -- Set when the row is consumed: the whole flow (exchange, identity lookup, persistence, margin) must end by then.
    -- Recovery settles an `exchanging` or `persisting` row only after it, whatever lease a claim it holds runs on.
    deadline_at timestamptz,
    completed_at timestamptz
);

create index if not exists integration_authorization_open
    on integration_authorization (expires_at) where status in ('pending', 'exchanging', 'persisting');
