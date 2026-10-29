-- Grant lineage (BEL-138): one integration_grant is one refresh lineage, so the lineage's claim, its
-- SecretStore operation and its destroy state live on the grant row. Expand only (docs/persistence.md): every
-- column is nullable and no old writer sets one, so a pod still on 094 inserts and updates grants as before.
--
-- `lineage_claim` is a lease token. A holder runs one exchange or one persistence under it with NO database lock
-- held; the claim ends by a statement that clears every `lineage_*` column (release, finalize, reconnect_required),
-- or by turning into a recorded `lineage_operation_id` that recovery owns once `lineage_claim_expires_at` passes.
-- `lineage_secret_ref` is the reference that operation targets: the grant's own, or a fresh one when the old
-- reference is wedged.
--
-- This file must contain NO `create extension`, per 005's header.

alter table integration_grant add column if not exists lineage_claim uuid;
alter table integration_grant add column if not exists lineage_claim_kind text
    check (lineage_claim_kind in ('refresh', 'reconsent', 'destroy'));
alter table integration_grant add column if not exists lineage_claim_expires_at timestamptz;
alter table integration_grant add column if not exists lineage_operation_id text;
alter table integration_grant add column if not exists lineage_secret_ref text;
alter table integration_grant add column if not exists secret_destroyed_at timestamptz;
-- Set when an unknown operation's payload is lost: the store then refuses every fresh mutation on `secret_ref`.
alter table integration_grant add column if not exists secret_wedged_at timestamptz;

create index if not exists integration_grant_lineage_expiry
    on integration_grant (lineage_claim_expires_at) where lineage_claim is not null;
create index if not exists integration_grant_destroy_pending
    on integration_grant (id) where status = 'revoked' and secret_version is not null and secret_wedged_at is null;
