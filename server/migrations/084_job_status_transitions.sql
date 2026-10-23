-- The board's job status transitions, explicit (issue #821): the only `job.status` moves storage
-- accepts, whichever statement writes them. Each operation still guards its own preconditions (lease
-- token, expiry, staged conclusion) in its transactional WHERE; this is the graph they all move along.
--
--   queued  -> running | stopped
--   running -> queued | succeeded | failed | dead | stopped
--   succeeded -> failed   only as the completion policy's refusal, inside the verdict's transaction:
--                         enforceCompletionPolicy marks it with the transaction-local
--                         `factory.policy_refusal` setting naming the row (job-store-evidence.ts).
--
-- Anything else is a board bug, refused with 23514 under the constraint name `job_status_transition`.
create or replace function job_status_transition() returns trigger
language plpgsql as $$
begin
    if (old.status, new.status) in (
        ('queued', 'running'), ('queued', 'stopped'),
        ('running', 'queued'), ('running', 'succeeded'), ('running', 'failed'),
        ('running', 'dead'), ('running', 'stopped')
    ) then
        return new;
    end if;
    if old.status = 'succeeded' and new.status = 'failed'
       and current_setting('factory.policy_refusal', true) = old.id::text then
        return new;
    end if;
    raise exception 'job %: % -> % is not a board transition', old.id, old.status, new.status
        using errcode = '23514', constraint = 'job_status_transition';
end $$;

drop trigger if exists job_status_transition on job;
create trigger job_status_transition before update of status on job
    for each row when (old.status is distinct from new.status) execute function job_status_transition();
