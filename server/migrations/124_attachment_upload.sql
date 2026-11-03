-- Attachment upload capabilities (BEL-248): a short-lived, single-use grant to upload ONE file for a member, handed
-- to a client that cannot send bytes through MCP. The capability itself is a bearer secret and is never stored: only
-- its sha256 is. It is bound to the account, the org and (for an MCP grant) the OAuth family it was minted under, so
-- revoking the grant or removing the membership ends it; the live join happens at use, nothing here cascades from
-- membership. `attachment_id` is set once the file is `ready` in `input_attachment` (115); the capability is spent by
-- that file's idempotency key, not by this column. This file must contain NO `create extension`, per 005's header.
--
-- Expand only (docs/persistence.md): a new table.

create table if not exists attachment_upload (
    id              uuid not null default gen_random_uuid(),
    org_id          text not null references organization (id) on update cascade on delete cascade,
    user_id         uuid not null references app_user (id) on delete cascade,
    family_id       uuid references oauth_grant_family (id) on delete cascade,
    capability_hash bytea not null,
    max_bytes       bigint not null check (max_bytes > 0),
    media_types     text[] not null,
    created_at      timestamptz not null default now(),
    expires_at      timestamptz not null,
    attachment_id   uuid,
    completed_at    timestamptz,
    primary key (id),
    unique (capability_hash)
);

create index if not exists attachment_upload_expires on attachment_upload (expires_at);
