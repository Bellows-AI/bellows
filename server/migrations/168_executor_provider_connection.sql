-- An executor profile selects at most one provider connection (docs/workspace.md): the credential
-- and endpoint its tasks run on, resolved by the claim from the connection's sealed key. NULL is the
-- behaviour every profile had before this column — the stacked env and the pasted config alone.
--
-- The reference is the connection's full primary key, (org_id, id), per docs/organizations.md. A
-- nullable column under the default MATCH SIMPLE is unchecked while NULL, so an unreferencing
-- profile costs nothing. Deletion is REFUSED: a connection a profile still names is refused
-- loudly by the store (provider-connection-store.ts), never cleared silently, and the foreign key is
-- what makes that race-safe. NO ACTION, not RESTRICT: both are refusals, but NO ACTION is checked when
-- the statement ends, so deleting a member (or an organization) that cascades to both a personal
-- connection and the profile naming it is not refused by the order the cascade happens to visit them in.
-- An insert naming a connection another transaction is deleting either
-- waits for the delete or fails its own check, so no profile is left dangling.
--
-- Scope and compatibility (an org profile names org connections only; the provider must run the
-- profile's executor type) are rules over TWO rows and are enforced by the writers in one
-- transaction and again at claim, not by a constraint.
--
-- This file must contain NO `create extension`, per 005's header: without them postgres wraps the
-- whole body in an implicit transaction, so a crashed run rolls back whole instead of leaving half
-- a schema behind.
alter table executor_profile add column if not exists provider_connection_id uuid;

alter table executor_profile drop constraint if exists executor_profile_provider_connection_fk;
alter table executor_profile add constraint executor_profile_provider_connection_fk
    foreign key (org_id, provider_connection_id)
    references provider_connection (org_id, id) on delete no action;

create index if not exists executor_profile_provider_connection_idx
    on executor_profile (org_id, provider_connection_id) where provider_connection_id is not null;
