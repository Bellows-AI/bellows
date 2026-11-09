-- Who wrote each skill version, so the Settings page can show an author per version. Null for a version written
-- before this column existed (no backfill) and once the user row is deleted.
--
-- Expand only (docs/persistence.md): one nullable column.

alter table skill_version
    add column if not exists created_by uuid references app_user (id) on delete set null;
