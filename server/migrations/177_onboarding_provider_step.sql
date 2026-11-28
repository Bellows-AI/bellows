-- The onboarding step "model" is now "provider" (Connect a provider, docs/auth.md): a member's recorded
-- setup_done / setup_skipped values are rewritten, and 156's two step checks are swapped for the new set.
--
-- Only rows that hold the old value are touched. The old checks go first, since they refuse the new value, and the new
-- ones are added NOT VALID and then validated: every row now satisfies them, and the two steps keep the lock short.
-- Every statement is idempotent on a rerun.
alter table org_membership drop constraint if exists org_membership_setup_done_step;
alter table org_membership drop constraint if exists org_membership_setup_skipped_step;

update org_membership set setup_done = array_replace(setup_done, 'model', 'provider')
where 'model' = any(setup_done);
update org_membership set setup_skipped = array_replace(setup_skipped, 'model', 'provider')
where 'model' = any(setup_skipped);

alter table org_membership
    add constraint org_membership_setup_done_step check (setup_done <@ array['provider', 'tools']::text[]) not valid,
    add constraint org_membership_setup_skipped_step check (setup_skipped <@ array['provider', 'tools']::text[]) not valid;
alter table org_membership validate constraint org_membership_setup_done_step;
alter table org_membership validate constraint org_membership_setup_skipped_step;
