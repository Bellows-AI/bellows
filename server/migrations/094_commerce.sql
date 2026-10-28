-- Commerce groundwork (BEL-146; docs/commerce.md): the plan an external commerce service pushed for an
-- organization, and the outbox of execution-usage reports the board owes that service. Both tables are
-- written only when COMMERCE_ENABLED is true; with it off they stay empty. New tables only.
--
--   org_plan                the last plan pushed for an org. `version` is the service's monotonic
--                           revision: an older or equal push never overwrites. No row means no push yet.
--                           No foreign key to organization (provenance precedent, 085): the write
--                           itself checks the org exists.
--   commerce_usage_report   one row per closed `job_execution` claim, the same key. The minutes are read
--                           from job_execution at lease time, never copied here: this table records
--                           DELIVERY only. A leased row carries `claim_token` and `claimed_until`; a
--                           settle applies only while its token still stands.
--
-- This file must contain NO `create extension`, per 005's header.

create table if not exists org_plan (
    org_id            text        primary key,
    plan              text        not null check (plan in ('free', 'pro', 'enterprise')),
    included_minutes  bigint      check (included_minutes >= 0),
    used_minutes      bigint      check (used_minutes >= 0),
    period_start      timestamptz,
    period_end        timestamptz,
    version           bigint      not null check (version > 0),
    updated_at        timestamptz not null default now(),
    constraint org_plan_period_ordered check (period_start is null or period_end is null or period_end >= period_start)
);

create table if not exists commerce_usage_report (
    org_id           text        not null,
    job_id           uuid        not null,
    claim_seq        bigint      not null,
    reported_at      timestamptz,
    claim_token      uuid,
    claimed_until    timestamptz,
    failures         integer     not null default 0,
    next_attempt_at  timestamptz not null default now(),
    error_code       text,
    created_at       timestamptz not null default now(),
    primary key (org_id, job_id, claim_seq)
);

create index if not exists commerce_usage_report_due
    on commerce_usage_report (org_id, next_attempt_at) where reported_at is null;
