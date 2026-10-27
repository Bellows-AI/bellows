-- BEL-136: the PostgreSQL backend of the SecretStore contract (server/src/secrets/postgres-secret-store.ts,
-- docs/secrets.md). Ciphertext is the only form a payload takes here: `secret_version.envelope` is an
-- AES-256-GCM envelope whose key lives outside the database. No table holds plaintext, a bare payload hash
-- or a key.
--
--   secret            one row per reference; `identity_key` is the canonical identity (identityKey()), the
--                     row outlives a delete as a tombstone so a reference is never reused. No foreign key to
--                     organization or app_user: purging an owner's secrets is the consumers' job.
--   secret_version    immutable encrypted versions. Only `state` ever changes after the insert; no statement
--                     updates `envelope`, `key_id` or `logical_version`. `id` is the private storage version
--                     (allocated at intent); there is no foreign key to `secret`, because a create stages its
--                     version before its secret row exists.
--   secret_active     the active pointer, one row per live reference. The foreign key to secret_version has no
--                     cascade, so nothing can delete an active version, the collector included.
--   secret_operation  the intent and outcome record of one mutation. `fingerprint` is an HMAC under a key held
--                     outside the database. A row stays while it is pending or unknown (completed_at_ms is
--                     null); a terminal row is pruned 7 days after completion.
--
-- Times are bigint milliseconds from the store's injected clock.

create table if not exists secret (
    ref text primary key,
    identity_key text not null,
    state text not null check (state in ('active', 'tombstoned')),
    created_at_ms bigint not null,
    updated_at_ms bigint not null
);

create table if not exists secret_version (
    id uuid primary key,
    ref text not null,
    logical_version text not null,
    key_id text not null,
    envelope bytea not null,
    state text not null check (state in ('staged', 'active', 'collectable', 'cleanup-pending')),
    operation_id text,
    created_at_ms bigint not null
);

create index if not exists secret_version_ref on secret_version (ref);
-- A reference has at most one active version, whatever a bug or a race tries.
create unique index if not exists secret_version_one_active on secret_version (ref) where state = 'active';

create table if not exists secret_active (
    ref text primary key references secret (ref),
    version_id uuid not null references secret_version (id),
    logical_version text not null
);

create table if not exists secret_operation (
    operation_id text primary key,
    kind text not null check (kind in ('create', 'replace', 'delete')),
    ref text not null,
    identity_key text not null,
    expected_version text,
    fingerprint text not null,
    state text not null check (state in ('pending', 'unknown', 'succeeded', 'failed')),
    version_id uuid,
    new_version text,
    error_code text,
    error_reason text,
    issued_at_ms bigint not null,
    completed_at_ms bigint,
    check ((state in ('pending', 'unknown')) = (completed_at_ms is null))
);

create index if not exists secret_operation_unresolved on secret_operation (ref)
    where state in ('pending', 'unknown');
create index if not exists secret_operation_completed on secret_operation (completed_at_ms)
    where completed_at_ms is not null;
