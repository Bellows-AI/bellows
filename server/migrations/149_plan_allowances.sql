-- Spend and storage allowances per organization (docs/commerce.md), beside 139's running, queued and wall-time limits.
-- The commerce push carries them on `org_plan`; a null column, or no row at all, takes the board's default
-- (PLAN_DEFAULT_MAX_TOKENS, PLAN_DEFAULT_MAX_STORAGE_BYTES, the Free plan, required in cloud mode).
--
--   max_tokens         tokens the org's runs may report per period; a new task past it is refused naming `tokens`.
--   max_storage_bytes  attachment and run-log bytes the org may hold; an upload past it is refused naming `storage`.
--
-- org_plan is one row per organization, so adding nullable columns is a catalog change.
alter table org_plan add column if not exists max_tokens bigint check (max_tokens > 0);
alter table org_plan add column if not exists max_storage_bytes bigint check (max_storage_bytes > 0);

-- Tokens reported per organization per UTC day: the rollup the create reads instead of aggregating metric_point (the
-- largest table) per request. The ingest adds the delta token points it actually inserted, in the same transaction,
-- so an at-least-once retry is counted once. A period is a range of days, so the read is one primary-key range.
-- Expand only: a new table, nothing backfilled. Usage reported before this file is not counted.
create table if not exists org_token_usage (
    org_id text not null references organization (id) on update cascade on delete cascade,
    day date not null,
    tokens bigint not null check (tokens >= 0),
    primary key (org_id, day)
);
