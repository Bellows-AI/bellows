-- Task attachments, binding: a `ready` file is bound to the job that carried it, in the transaction that inserts
-- the job. `root_job_id` is the thread the job belongs to (a read and the removal address a file by it),
-- `bound_job_id` the request that carried it, `position` its place in that request's list.
--
-- No foreign key to `job`: an older pod's `delete from job` must keep working, and the thread read joins to the
-- job row, so a file whose job is gone is served to nobody. Removing a thread flips its bound files to
-- `deleting` in the same transaction.
--
-- Expand only (docs/persistence.md): nullable columns and an index. This file must contain NO `create extension`,
-- per 005's header.

alter table input_attachment add column if not exists bound_job_id uuid;
alter table input_attachment add column if not exists root_job_id uuid;
alter table input_attachment add column if not exists bound_at timestamptz;
alter table input_attachment add column if not exists position int;

create index if not exists input_attachment_root on input_attachment (org_id, root_job_id);
