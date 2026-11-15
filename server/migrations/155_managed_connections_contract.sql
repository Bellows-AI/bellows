-- Contract of the managed-connections model: removes 094's rollout bridge now that no running code writes it.
-- A root names its connections through `job_connection_binding` alone, so `job.jira_connection_id` and its
-- mirror trigger go; every connection row carries `provider`, so `connector_connection.kind` and the identity
-- trigger go; every root insert writes `execution_user_id`, so the stamping trigger goes.
-- `job.execution_user_id` never changes once the row exists: the one change allowed is to null, and only when the
-- account it named is gone (its foreign key's `on delete set null`).

drop trigger if exists job_binding_mirror_rollout_094 on job;
drop trigger if exists job_execution_user_rollout_094 on job;
drop trigger if exists connector_connection_identity_rollout_094 on connector_connection;

drop function if exists job_binding_mirror_rollout_094();
drop function if exists job_execution_user_rollout_094();
drop function if exists connector_connection_identity_rollout_094();

alter table job drop column if exists jira_connection_id;
alter table connector_connection drop column if exists kind;

create or replace function job_execution_user_immutable() returns trigger
language plpgsql as $$
begin
    if new.execution_user_id is distinct from old.execution_user_id
       and not (new.execution_user_id is null
                and not exists (select 1 from app_user where id = old.execution_user_id)) then
        raise exception 'job.execution_user_id is immutable' using errcode = '23514';
    end if;
    return new;
end;
$$;
