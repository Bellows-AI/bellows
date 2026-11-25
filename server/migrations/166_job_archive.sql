-- Archive replaces remove: an archived task leaves the active task list, but its thread, runs, logs,
-- PR links and attachments stay readable, and an unarchive brings it back.
--
-- The stamp rides every member of the thread, as done_at does, so a per-row read answers it and a
-- thread-wide clear (unarchive) is one update. archived_by is the actor, nullable and
-- on delete set null for the reason 025 gives: removing somebody from the organization must not
-- delete the record of what they did. A thread carrying the stamp is not subject to plan retention.
alter table job add column if not exists archived_at timestamptz;
alter table job add column if not exists archived_by uuid;

do $$ begin
    alter table job add constraint job_archived_by_fk
        foreign key (archived_by) references app_user (id) on delete set null;
exception when duplicate_object then null; end $$;
