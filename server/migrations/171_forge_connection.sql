-- An organization's connection to a self-hosted forge instance (docs/connections.md): today a GitLab host, its OAuth
-- application's client id, the root groups members' projects may come from, and the references to the client secret
-- and the optional CA bundle, both held in the secret store alone. A connection is stored PENDING (`active` false):
-- an unauthenticated reachability probe ran and its outcome is recorded, nothing gates on the row yet. The host is
-- unique per organization (among live rows), not globally: two organizations may connect the same instance with different applications.
-- New table, nothing to backfill: expand only (docs/persistence.md). This file must contain NO `create extension`,
-- per 005's header.
create table if not exists forge_connection (
    org_id text not null,
    id uuid not null default gen_random_uuid(),
    forge text not null,
    host text not null,
    client_id text not null,
    allowed_groups text[] not null,
    -- The references are recorded BEFORE the secrets are written, so a failed or interrupted create leaves a row (a
    -- tombstone, below) that names what to retire; the versions are filled when the connection is published.
    secret_ref text not null,
    secret_version text,
    ca_secret_ref text,
    ca_secret_version text,
    active boolean not null default false,
    probe_status text not null,
    probe_reason text,
    probed_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    -- Set when an admin deletes the connection, and from the start of a create until it publishes: the row stays,
    -- hidden, until the secret store confirmed both secrets retired, then goes. A sweep on every replica finishes what a
    -- lost process or an unavailable store left (a create still unpublished gets a grace period first).
    removed_at timestamptz,

    primary key (org_id, id),
    constraint forge_connection_org_fk foreign key (org_id)
        references organization (id) on update cascade on delete cascade,
    constraint forge_connection_forge_ck check (forge in ('gitlab')),
    constraint forge_connection_host_ck check (host ~ '^[A-Za-z0-9.-]+(:[0-9]+)?$'),
    constraint forge_connection_client_ck check (client_id <> ''),
    constraint forge_connection_groups_ck check (cardinality(allowed_groups) > 0),
    constraint forge_connection_ca_ck check (ca_secret_version is null or ca_secret_ref is not null),
    -- A live row holds both versions it was published with; only a tombstone may lack them.
    constraint forge_connection_live_ck check (
        removed_at is not null or (secret_version is not null and (ca_secret_ref is null) = (ca_secret_version is null))
    ),
    constraint forge_connection_probe_ck check (
        (probe_status = 'reachable' and probe_reason is null)
        or (probe_status = 'unreachable' and probe_reason in ('timeout', 'unreachable', 'tls', 'server-error', 'malformed'))
    )
);

-- One live connection per host; a removed one awaiting its secrets' retirement does not hold it.
create unique index if not exists forge_connection_host_live on forge_connection (org_id, forge, host)
    where removed_at is null;

-- The policy 151 gave every org table.
alter table forge_connection enable row level security;
drop policy if exists org_isolation on forge_connection;
create policy org_isolation on forge_connection using (org_id = current_setting('app.org_id', true))
    with check (org_id = current_setting('app.org_id', true));
