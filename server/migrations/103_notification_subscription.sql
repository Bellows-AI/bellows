-- Notification subscriptions (BEL-131): who an org wants told about a notification_event. Org-owned rows; a
-- per-user subscription later adds a nullable user_id (an expansion), the org-owned rows staying NULL as
-- docs/organizations.md says. event_kinds mirrors 102's kind check and NOTIFICATION_KINDS in core: a new kind
-- touches all three. No FK to notification_event: a subscription is configuration, an event is a record.
-- Expand only (docs/persistence.md: a release only expands). This file must contain NO `create extension`, per
-- 005's header.

create table if not exists notification_subscription (
    org_id text not null references organization (id) on update cascade on delete cascade,
    id uuid not null default gen_random_uuid(),
    connector_kind text not null check (connector_kind <> ''),
    -- Non-secret JSON the registered connector's validateConfig accepted; credentials come with the first real channel.
    connector_config jsonb not null,
    event_kinds text[] not null
        check (cardinality(event_kinds) > 0 and event_kinds <@ array['task.ready', 'task.blocked', 'task.question']),
    -- Empty = every repo / every workflow. A filtered subscription never matches an event whose repo/workflow is null.
    repos text[] not null default '{}',
    workflows text[] not null default '{}',
    enabled boolean not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (org_id, id)
);
