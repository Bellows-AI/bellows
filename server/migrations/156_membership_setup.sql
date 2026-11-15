-- Onboarding setup state per membership (docs/auth.md). Three columns on org_membership, one row per (org, user):
--
--   setup_completed_at  when the member finished or left the setup flow; null sends the web into onboarding.
--   setup_done          the optional steps the member completed.
--   setup_skipped       the optional steps the member skipped; a step is in at most one of the two arrays.
--
-- Every membership that exists when this ships belongs to someone already using the board, so it is backfilled
-- completed and never pushed into onboarding. org_membership is one row per member: one update, no batching.
alter table org_membership
    add column if not exists setup_completed_at timestamptz,
    add column if not exists setup_done text[] not null default '{}'
        constraint org_membership_setup_done_step check (setup_done <@ array['model', 'tools']::text[]),
    add column if not exists setup_skipped text[] not null default '{}'
        constraint org_membership_setup_skipped_step check (setup_skipped <@ array['model', 'tools']::text[]);

update org_membership set setup_completed_at = now() where setup_completed_at is null;
