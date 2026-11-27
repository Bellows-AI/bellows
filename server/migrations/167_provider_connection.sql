-- Provider connections (docs/api.md): a model-provider credential as a first-class row an executor
-- profile can reference — one row per named credential, sealing its key in the secret store and
-- carrying the plain base URL beside it.
--
-- ONE TABLE, SIBLING SCOPES — the shape 047_executor_profile_scope.sql chose for executor profiles
-- and 114 for personal subscriptions: `user_id` is nullable and NULL is the org scope. A member's
-- own rows and the organization's rows live beside each other; the org-executor visibility split
-- (own + org) reads both, another member's personal row neither.
--
-- The primary key is (org_id, id), per docs/organizations.md, and name uniqueness WITHIN each
-- ownership scope comes from 047's coalesce index: personal rows key on their owner's id, org rows
-- on the NIL uuid, so the same name may exist once per member AND once for the organization.
-- Connection ids are stable: a rename or a key rotation rewrites the row, never its identity.
--
-- `provider` is checked against MODEL_PROVIDERS (core/src/model-providers.ts) the way 158 checks
-- the agent default's provider. `base_url` is a plain column, never a secret — the same rule as the
-- env base URL today. `secret_ref`/`secret_version` hold the opaque reference and the version the
-- row was written at; the key itself lives only in the secret store, under the identity the row's
-- slot implies (rebuilt on every call, never stored).
--
-- `created_by` records who created the row — an audit fact, not an ownership: any current admin
-- manages every org row regardless of who created it.
--
-- This file must contain NO `create extension`, per 005's header: without them postgres wraps the
-- whole body in an implicit transaction, so a crashed run rolls back whole instead of leaving half
-- a schema behind.
create table if not exists provider_connection (
    org_id         text not null,
    id             uuid not null default gen_random_uuid(),
    user_id        uuid,
    name           text not null,
    provider       text not null,
    base_url       text,
    secret_ref     text not null,
    secret_version text not null,
    created_by     uuid references app_user (id) on delete set null,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),

    constraint provider_connection_pk primary key (org_id, id),
    constraint provider_connection_org_fk foreign key (org_id)
        references organization (id) on update cascade on delete cascade,
    constraint provider_connection_user_fk foreign key (user_id)
        references app_user (id) on delete cascade,
    constraint provider_connection_provider_ck
        check (provider in ('anthropic', 'openrouter', 'openai', 'litellm', 'subscription')),
    constraint provider_connection_name_ck check (char_length(name) between 1 and 200),
    constraint provider_connection_base_url_ck check (base_url is null or char_length(base_url) between 1 and 2048)
);

-- Name uniqueness within each ownership scope (047's coalesce shape): the same name may exist once
-- per member and once for the organization, and a scope switch would never collide by accident —
-- scopes are immutable on this table in any case.
create unique index if not exists provider_connection_name_uk on provider_connection (
    org_id,
    coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    name
);

-- The policy 151 gave every org table.
alter table provider_connection enable row level security;
drop policy if exists org_isolation on provider_connection;
create policy org_isolation on provider_connection using (org_id = current_setting('app.org_id', true))
    with check (org_id = current_setting('app.org_id', true));
