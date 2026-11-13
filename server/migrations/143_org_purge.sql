-- An organization being deleted (docs/organizations.md, server/src/db/org-purge.ts). One row per purge, written by the
-- operator's delete or, in cloud mode, by GitHub's deletion deadline passing; only a suspended or refused org gets one.
-- The purge walks its steps in order and records each one it has confirmed:
--   secrets — every secret the org owns is deleted and physically collected, then its tombstone and operation rows go;
--   objects — every key under the org's artifact, attachment and skill prefixes is deleted;
--   rows    — the organization row is deleted, which cascades through every org table, this row included.
-- A step that cannot be confirmed stays where it is: `attempts` counts the passes that failed and `last_error` holds a
-- closed code, never tenant data. Nothing marks a purge done; the org row and this one disappear together.
create table if not exists org_purge (
    org_id text primary key references organization (id) on delete cascade,
    source text not null check (source in ('operator', 'deadline')),
    requested_by text,
    requested_at timestamptz not null default now(),
    step text not null default 'secrets' check (step in ('secrets', 'objects', 'rows')),
    attempts integer not null default 0,
    last_error text,
    updated_at timestamptz not null default now(),
    check ((source = 'operator') = (requested_by is not null))
);
