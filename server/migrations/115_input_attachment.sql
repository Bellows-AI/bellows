-- Task attachments: a file a member uploads before submitting a task. The bytes live in the object store under a
-- generated key (`<prefix>_attachments/<org>/<id>`); this table is the index that arbitrates them. A draft is
-- `pending` (row written, object not confirmed) then `ready`; binding it to a task, and the removal states, are
-- the later slices'. A removed row stays as a `deleted` tombstone. A row whose uploader account is deleted keeps
-- its object for the sweep, and no member can read it any more.
--
-- `idempotency_*` make an upload replayable: the key is scoped to org, uploader and the `attachment-upload`
-- operation, and the fingerprint is the sha256, size and name of the request.
--
-- Expand only (docs/persistence.md): a new table. This file must contain NO `create extension`, per 005's header.

create table if not exists input_attachment (
    org_id text not null references organization (id) on update cascade on delete cascade,
    id uuid not null,
    uploader_id uuid references app_user (id) on delete set null,
    name text not null,
    media_type text not null,
    size_bytes bigint not null check (size_bytes >= 0),
    sha256 text not null,
    object_key text not null,
    state text not null check (state in ('pending', 'ready', 'bound', 'deleting', 'deleted')),
    created_at timestamptz not null default now(),
    ready_at timestamptz,
    deleting_at timestamptz,
    deleted_at timestamptz,
    idempotency_key text,
    idempotency_fingerprint text,
    idempotency_at timestamptz,
    primary key (org_id, id)
);

create index if not exists input_attachment_state_created on input_attachment (state, created_at);

create unique index if not exists input_attachment_idempotency
    on input_attachment (org_id, uploader_id, idempotency_key)
    where idempotency_key is not null;
