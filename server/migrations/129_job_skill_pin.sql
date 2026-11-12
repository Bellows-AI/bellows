-- Org and workspace skill versions pinned per job row. `skill_pin` is the array of
-- `{name, source, versionId, sha256}` the row's task selected from the org's skills and its owner's workspace, resolved
-- once when the row is made and never rewritten: a create and a follow-up resolve it, a retry, a workflow successor and
-- a durable-wait wake copy it, a reviewer row stays empty. The claim hands the row's own pin to the runner, the content
-- route serves only versions it names, and the skill retention sweep keeps every version any row names.
--
-- Expand only (docs/persistence.md): one defaulted column, so rows made before it hold no pin.

alter table job add column if not exists skill_pin jsonb not null default '[]'::jsonb;

-- The sweep asks which of a few version ids some row names; a containment probe over the pin's entries.
create index if not exists job_skill_pin_versions on job using gin (skill_pin jsonb_path_ops)
    where skill_pin <> '[]'::jsonb;
