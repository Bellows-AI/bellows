-- Attachment upload capabilities: a short-lived, single-use grant to upload ONE file for a member, handed
-- to a client that cannot send bytes through MCP. The capability itself is a bearer secret and is never stored: only
-- its sha256 is. It is bound to the account, the org and the ONE credential it was minted under (an OAuth grant
-- family, a web session or a personal access token), so revoking the grant, signing out, revoking the token or
-- removing the membership ends it; the live join happens at use, nothing here cascades from membership. A board
-- with AUTH_MODE=none has no credential to bind, and all three columns stay null. `attachment_id` is set once the file is `ready` in `input_attachment` (115); the capability is spent by
-- that file's idempotency key, not by this column. This file must contain NO `create extension`, per 005's header.
--
-- Expand only (docs/persistence.md): a new table.

create table if not exists attachment_upload (
    id              uuid not null default gen_random_uuid(),
    org_id          text not null references organization (id) on update cascade on delete cascade,
    user_id         uuid not null references app_user (id) on delete cascade,
    family_id       uuid references oauth_grant_family (id) on delete cascade,
    session_hash    bytea references session (token_hash) on delete cascade,
    access_token_id uuid,
    capability_hash bytea not null,
    max_bytes       bigint not null check (max_bytes > 0),
    media_types     text[] not null,
    created_at      timestamptz not null default now(),
    expires_at      timestamptz not null,
    attachment_id   uuid,
    completed_at    timestamptz,
    primary key (id),
    unique (capability_hash),
    constraint attachment_upload_one_credential check (num_nonnulls(family_id, session_hash, access_token_id) <= 1),
    constraint attachment_upload_token_fk foreign key (org_id, access_token_id)
        references access_token (org_id, id) on delete cascade
);

-- Each cascading parent deletes by these columns; the primary key leads with neither.
create index if not exists attachment_upload_by_user on attachment_upload (user_id);
create index if not exists attachment_upload_by_family on attachment_upload (family_id) where family_id is not null;
create index if not exists attachment_upload_by_session on attachment_upload (session_hash) where session_hash is not null;
create index if not exists attachment_upload_by_token
    on attachment_upload (access_token_id) where access_token_id is not null;

create index if not exists attachment_upload_expires on attachment_upload (expires_at);
