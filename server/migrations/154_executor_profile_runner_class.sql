-- The runner class an organization executor profile's tasks run in (RUNNER_CLASSES on the driver): null is the
-- driver's default class. An org admin sets it; a personal profile never carries one, which the check holds at the
-- row. Resolved at claim like the profile's type, so an edit reaches every later claim (docs/workspace.md).
--
-- Expand only (docs/persistence.md): one nullable column and a check every existing row passes.

alter table executor_profile add column if not exists runner_class text null;

alter table executor_profile drop constraint if exists executor_profile_runner_class_ck;
alter table executor_profile add constraint executor_profile_runner_class_ck
    check (user_id is null or runner_class is null);
