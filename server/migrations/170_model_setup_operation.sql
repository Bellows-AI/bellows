-- The model setup's durable operation receipts (docs/persistence.md): one row per setup request a scope has applied,
-- keyed by the client's request id. The setup command publishes a connection, an executor and the default selection in
-- one transaction under a per-scope lock, then writes its receipt in the same transaction, so a retry or a concurrent
-- duplicate of the same request finds the receipt and answers the same executor and connection instead of creating a
-- second pair.
--
-- `owner_id` NULL is the organization's scope, a member's id their personal one — the shape 169 uses for the default
-- selection. A receipt holds only safe result metadata: the two stable ids and a fingerprint of the non-secret fields
-- of the command, so the same request id with a different command is refused rather than replayed. No credential, key
-- hash or secret reference is ever written here.
--
-- Both references cascade: a receipt whose executor or connection was deleted describes nothing, and its request id may
-- then be applied afresh. The executor reference never blocks a deletion (the default selection's own deferred
-- reference and the connection's reference guard those).
--
-- This file must contain NO `create extension`, per 005's header: without them postgres wraps the
-- whole body in an implicit transaction, so a crashed run rolls back whole instead of leaving half
-- a schema behind.
create table if not exists model_setup_operation (
    org_id        text not null,
    id            uuid not null default gen_random_uuid(),
    owner_id      uuid,
    request_id    text not null,
    fingerprint   text not null,
    executor_id   uuid not null,
    connection_id uuid,
    created_by    uuid references app_user (id) on delete set null,
    created_at    timestamptz not null default now(),

    constraint model_setup_operation_pk primary key (org_id, id),
    constraint model_setup_operation_org_fk foreign key (org_id)
        references organization (id) on update cascade on delete cascade,
    constraint model_setup_operation_owner_fk foreign key (owner_id)
        references app_user (id) on delete cascade,
    constraint model_setup_operation_executor_fk foreign key (org_id, executor_id)
        references executor_profile (org_id, id) on delete cascade,
    constraint model_setup_operation_connection_fk foreign key (org_id, connection_id)
        references provider_connection (org_id, id) on delete cascade,
    constraint model_setup_operation_request_ck check (char_length(request_id) between 1 and 128)
);

create unique index if not exists model_setup_operation_request_uk on model_setup_operation (
    org_id,
    coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid),
    request_id
);

-- The policy 151 gave every org table.
alter table model_setup_operation enable row level security;
drop policy if exists org_isolation on model_setup_operation;
create policy org_isolation on model_setup_operation using (org_id = current_setting('app.org_id', true))
    with check (org_id = current_setting('app.org_id', true));
