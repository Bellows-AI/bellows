-- Inbound OAuth for the MCP server (BEL-101): an MCP client obtains `mat_` access and `mrt_` refresh tokens for an
-- account in one org. Distinct from the outbound provider connections (054). Reach is never stored here: a token
-- resolves through the LIVE org_membership join, so nothing below cascades from membership. This file must contain
-- NO `create extension`, per 005's header.

-- A client is either fetched from its URL client id (cimd, metadata cached) or registered (dcr, expires unused).
create table if not exists oauth_client (
    client_id     text not null,
    kind          text not null,
    client_name   text,
    redirect_uris text[] not null,
    metadata      jsonb,
    fetched_at    timestamptz,
    created_at    timestamptz not null default now(),
    last_used_at  timestamptz,
    constraint oauth_client_pk primary key (client_id),
    constraint oauth_client_kind_ck check (kind in ('cimd', 'dcr')),
    constraint oauth_client_cimd_fetched_ck check (kind <> 'cimd' or fetched_at is not null)
);

-- The lock record and scope ceiling of one grant; every token of the grant points here.
create table if not exists oauth_grant_family (
    id         uuid not null default gen_random_uuid(),
    client_id  text not null,
    user_id    uuid not null,
    org_id     text not null,
    resource   text not null,
    scopes     text[] not null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    revoked_at timestamptz,
    constraint oauth_grant_family_pk primary key (id),
    constraint oauth_grant_family_client_fk foreign key (client_id) references oauth_client (client_id),
    constraint oauth_grant_family_user_fk foreign key (user_id) references app_user (id) on delete cascade,
    constraint oauth_grant_family_org_fk foreign key (org_id)
        references organization (id) on update cascade on delete cascade
);

-- A used code is kept (its family_id is what a replay revokes) until the family expires.
create table if not exists oauth_authorization_code (
    code_hash      bytea not null,
    client_id      text not null,
    user_id        uuid not null,
    org_id         text not null,
    scopes         text[] not null,
    code_challenge text not null,
    resource       text not null,
    redirect_uri   text not null,
    created_at     timestamptz not null default now(),
    expires_at     timestamptz not null,
    used_at        timestamptz,
    family_id      uuid,
    constraint oauth_authorization_code_pk primary key (code_hash),
    constraint oauth_authorization_code_client_fk foreign key (client_id) references oauth_client (client_id),
    constraint oauth_authorization_code_user_fk foreign key (user_id) references app_user (id) on delete cascade,
    constraint oauth_authorization_code_org_fk foreign key (org_id)
        references organization (id) on update cascade on delete cascade,
    constraint oauth_authorization_code_family_fk foreign key (family_id)
        references oauth_grant_family (id) on delete cascade
);

create table if not exists oauth_token (
    token_hash   bytea not null,
    kind         text not null,
    family_id    uuid not null,
    scopes       text[] not null,
    created_at   timestamptz not null default now(),
    expires_at   timestamptz not null,
    revoked_at   timestamptz,
    rotated_at   timestamptz,
    rotated_from bytea,
    constraint oauth_token_pk primary key (token_hash),
    constraint oauth_token_kind_ck check (kind in ('access', 'refresh')),
    constraint oauth_token_family_fk foreign key (family_id) references oauth_grant_family (id) on delete cascade
);
create index if not exists oauth_token_family_idx on oauth_token (family_id);

-- The server-side consent transaction the consent screen is rendered from and the approve/deny submit consumes.
create table if not exists oauth_consent_transaction (
    id_hash        bytea not null,
    session_hash   bytea not null,
    client_id      text not null,
    redirect_uri   text not null,
    resource       text not null,
    scopes         text[] not null,
    code_challenge text not null,
    client_state   text,
    csrf_hash      bytea not null,
    created_at     timestamptz not null default now(),
    expires_at     timestamptz not null,
    used_at        timestamptz,
    constraint oauth_consent_transaction_pk primary key (id_hash),
    constraint oauth_consent_transaction_client_fk foreign key (client_id) references oauth_client (client_id)
);
