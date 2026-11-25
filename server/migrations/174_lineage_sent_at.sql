-- The durable "this refresh may have been sent" mark of a grant's lineage claim (docs/connections.md): set, before the
-- request to a rotating provider is dispatched, on the claim that is about to spend the refresh token. A marked claim
-- ends only by committing the new credentials or by moving the grant to reconnect_required; the claim statements
-- refuse an ordinary release of it, and an expired marked claim is read as "reconnect needed", never as free. Cleared
-- by every statement that ends a claim. Expand only (docs/persistence.md): one nullable column, no backfill, no scan.
-- This file must contain NO `create extension`, per 005's header.
alter table integration_grant add column if not exists lineage_sent_at timestamptz;
