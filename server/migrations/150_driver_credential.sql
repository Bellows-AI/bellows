-- Per-driver credentials (docs/auth.md): the board operator issues one per driver, for named organizations or for the
-- pool (every organization). Only the SHA-256 of the token is stored; the token is shown once, at issue.
--
--   pool          true: the credential claims for every organization; false: only the organizations in
--                 driver_credential_org. A scoped credential whose organizations were all deleted reaches nothing.
--   revoked_at    set by a revoke; the credential is refused from its next call.
--   expires_at    set by a rotation: the end of the overlap window in which the old credential still works.
--   rotated_from  the credential this one replaced; a credential is rotated at most once.
--
-- Expand only: two new tables, nothing backfilled.
create table if not exists driver_credential (
    id uuid primary key default gen_random_uuid(),
    label text not null check (length(label) between 1 and 100),
    token_hash bytea not null unique,
    pool boolean not null,
    created_at timestamptz not null default now(),
    created_by uuid references app_user (id) on delete set null,
    revoked_at timestamptz,
    expires_at timestamptz,
    rotated_from uuid unique references driver_credential (id) on delete set null
);

-- A scoped credential's organizations. Deleting an organization removes it from every credential.
create table if not exists driver_credential_org (
    credential_id uuid not null references driver_credential (id) on delete cascade,
    org_id text not null references organization (id) on update cascade on delete cascade,
    primary key (credential_id, org_id)
);

create index if not exists driver_credential_org_org_id on driver_credential_org (org_id);
