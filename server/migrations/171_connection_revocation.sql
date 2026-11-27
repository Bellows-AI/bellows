-- Jira connections end with the access they depend on (docs/connections.md, "Revocation").
--
-- `background_lease`: one row per named background pass that must run on one replica at a time. A replica takes the
-- row by name while it is free or its holder's lease has run out, so a replica that dies mid-pass delays the next
-- pass by one lease, never forever. It holds no org data, so it carries no `org_id`.
--
-- `connector_connection.site_checked_at`: when the site access re-check last got a confirmed answer for the
-- connection; null until the first one. The re-check works the oldest first.
--
-- This file must contain NO `create extension`, per 005's header.
create table if not exists background_lease (
    name       text primary key,
    holder     text not null,
    expires_at timestamptz not null
);

alter table connector_connection add column if not exists site_checked_at timestamptz;
