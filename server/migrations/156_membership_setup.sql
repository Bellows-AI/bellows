-- Onboarding setup state per membership (docs/auth.md). Three columns on org_membership, one row per (org, user):
--
--   setup_completed_at  when the member finished or left the setup flow; null sends the web into onboarding.
--   setup_done          the optional steps the member completed.
--   setup_skipped       the optional steps the member skipped; a step is in at most one of the two arrays.
--
-- Metadata only, so the boot lock is never held for a table scan (docs/persistence.md). Every membership that exists
-- when this ships belongs to someone already using the board, so it must read completed: the column is added with a
-- CONSTANT default (stored once in the catalog, no rewrite; a constant, not now(), per migrations-rewrite.test.ts), which
-- existing rows read, and the default is then dropped so a membership created after this starts null. The step checks
-- are added NOT VALID: existing rows hold only the empty default, and every later write is checked.
alter table org_membership
    add column if not exists setup_completed_at timestamptz default '2026-11-15 00:00:00+00'::timestamptz,
    add column if not exists setup_done text[] not null default '{}',
    add column if not exists setup_skipped text[] not null default '{}';

alter table org_membership alter column setup_completed_at drop default;

alter table org_membership
    add constraint org_membership_setup_done_step check (setup_done <@ array['model', 'tools']::text[]) not valid,
    add constraint org_membership_setup_skipped_step check (setup_skipped <@ array['model', 'tools']::text[]) not valid;
