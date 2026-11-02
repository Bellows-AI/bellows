-- The branch a task bases its checkout and PR on, named at task creation. ONLY THE ROOT's
-- value means anything: a follow-up, retry or workflow successor keeps the default and the claim reads
-- the thread root's choice, so every row of a thread and every reclaim of it sees the same branch
-- without an insert site copying it. A batch task's frozen target branch still wins at claim time.
-- NULL means the remote default (origin/HEAD at checkout).
--
-- This file must contain NO `create extension`, per 005's header.

alter table job add column if not exists base_branch text;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'job_base_branch_length') then
        alter table job add constraint job_base_branch_length
            check (base_branch is null or char_length(base_branch) between 1 and 255);
    end if;
end $$;
