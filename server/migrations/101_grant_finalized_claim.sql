-- Finalized-claim marker (BEL-164): the token of the last `reconsent` claim that finalized the grant. An authorization
-- that recorded its claim settles from it: the marker equal to the authorization's claim means the credentials landed.
-- Expand only (docs/persistence.md: a release only expands): nullable, no check, no backfill. This file must contain
-- NO `create extension`, per 005's header.

alter table integration_grant add column if not exists lineage_finalized_claim uuid;
