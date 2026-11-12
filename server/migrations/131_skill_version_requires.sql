-- The tools and managed connections a stored skill declares in its SKILL.md `metadata:` block. Parsed at
-- upload, so the catalog, preflight and create read them from the version row. A version uploaded before this column
-- existed declares none until the same bytes are uploaded again (docs/skills.md).
--
-- Expand only (docs/persistence.md): two columns with defaults.

alter table skill_version
    add column if not exists requires_tools text[] not null default '{}',
    add column if not exists requires_connections text[] not null default '{}';
