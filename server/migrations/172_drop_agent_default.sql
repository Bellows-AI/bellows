-- Removes the agent default (157, 158): a task names an executor or runs on the member's configured default executor
-- (169), never on an agent and model of its own. Work frozen with an agent default that has not started is moved
-- first, then the columns and tables go.
--
-- Every row that carries an agent default and no executor takes the executor its member configured, the personal
-- selection before the organization's, when that profile is active: a follow-up, a retry, a takeover and a workflow
-- round copy the executor of the row before them, and a row left without one would mint work the claim refuses. What
-- has not started and finds none is ended with a named reason: a queued job fails, a pending task of a started batch
-- is refused, a parked wait is cancelled. Started or finished work that finds none stays as it is. A batch that has
-- not started (a draft) is left alone: its plan is still edited and its start resolves the executor.
-- `user_executor_default` (047) goes with the agent default: only a configured selection names a default now.
--
-- This file must contain NO `create extension`, per 005's header.

-- The executor a member configured: the personal selection first, then the organization's. A suspended profile is
-- not a default anyone can run on. The scope is the profile's own: a member's row is 'user', the organization's 'org'.
create function pg_temp.configured_default(p_org text, p_user uuid) returns table (name text, scope text)
language sql stable as $$
    select p.name, case when p.user_id is null then 'org' else 'user' end
    from executor_default_selection s
    join executor_profile p on p.org_id = s.org_id and p.id = s.executor_id
    where s.org_id = p_org and not p.suspended and (s.owner_id = p_user or s.owner_id is null)
    order by (s.owner_id is null)
    limit 1
$$;

-- (a) Jobs of any status: the member is the thread root's execution identity.
create temp table agent_default_job on commit drop as
    select j.org_id, j.id, j.status = 'queued' as was_queued, d.name, d.scope
    from job j
    left join job r on r.org_id = j.org_id and r.id = j.root_job_id
    left join lateral pg_temp.configured_default(j.org_id, coalesce(r.execution_user_id, j.created_by)) d on true
    where j.executor is null and j.agent_type is not null;

update job j set executor = t.name, executor_scope = t.scope
from agent_default_job t
where t.name is not null and j.org_id = t.org_id and j.id = t.id;

-- The job graph has no queued -> failed edge (084): a queued job with nothing to run on takes the board's
-- queued -> running -> failed path, as a claim that failed at once would.
update job j set status = 'running', lease_token = null
from agent_default_job t
where t.name is null and t.was_queued and j.org_id = t.org_id and j.id = t.id;

update job j set status = 'failed', failure_kind = 'config', finished_at = now(), lease_token = null,
    output = 'its agent default was removed; pick an executor and start again'
from agent_default_job t
where t.name is null and t.was_queued and j.org_id = t.org_id and j.id = t.id and j.status = 'running';

-- (a) Tasks of started batches, whatever their execution (a retry re-dispatches from the plan row): the member is the
-- batch's starter. The plan columns of a started batch are immutable (059, 066), which is the trigger this one write
-- steps around.
create temp table agent_default_task on commit drop as
    select t.org_id, t.batch_id, t.key, d.name, d.scope
    from batch_task t
    join batch b on b.org_id = t.org_id and b.id = t.batch_id
    left join lateral pg_temp.configured_default(t.org_id, coalesce(b.started_by, b.created_by)) d on true
    where b.status = 'started' and t.executor is null and t.agent_type is not null;

alter table batch_task disable trigger batch_task_immutable;

update batch_task t set executor = d.name, executor_scope = d.scope
from agent_default_task d
where d.name is not null and t.org_id = d.org_id and t.batch_id = d.batch_id and t.key = d.key;

update batch_task t set execution = 'failed', attention = 'refused', recovery = null, not_before = null,
    wait_reason = 'its agent default was removed; pick an executor and start again'
from agent_default_task d
where d.name is null and t.execution = 'pending' and t.org_id = d.org_id and t.batch_id = d.batch_id
  and t.key = d.key;

-- Deferred constraint events from the writes above block an ALTER TABLE in the same transaction.
set constraints all immediate;

alter table batch_task enable trigger batch_task_immutable;

-- (a) Workflow rounds, parked or woken (the next round copies the last): the member is the thread runner, the root's
-- execution identity. A parked round with nothing to run on is ended by cancelling the wait it parks on, which is how
-- a closed or removed thread ends one.
create temp table agent_default_round on commit drop as
    select w.org_id, w.root_job_id, w.workflow_node, w.round, w.woken_at, d.name, d.scope
    from workflow_round w
    left join job r on r.org_id = w.org_id and r.id = w.root_job_id
    left join lateral pg_temp.configured_default(w.org_id, r.execution_user_id) d on true
    where w.executor is null and w.agent_type is not null;

update workflow_round w set executor = d.name, executor_scope = d.scope
from agent_default_round d
where d.name is not null and w.org_id = d.org_id and w.root_job_id = d.root_job_id
  and w.workflow_node = d.workflow_node and w.round = d.round;

update workflow_wait w set cancelled_at = coalesce(w.cancelled_at, now()),
    terminal_reason = coalesce(w.terminal_reason, 'its agent default was removed; pick an executor and start again')
from agent_default_round d
where d.name is null and d.woken_at is null and w.org_id = d.org_id and w.root_job_id = d.root_job_id
  and w.reason = d.workflow_node and w.completed_at is null;

-- (c) The columns and their checks (157). `agent_model` stays: a task may override its executor's model.
alter table job drop constraint if exists job_agent_type_ck;
alter table job drop column if exists agent_type;
alter table batch_task drop constraint if exists batch_task_agent_type_ck;
alter table batch_task drop column if exists agent_type;
alter table workflow_round drop constraint if exists workflow_round_agent_type_ck;
alter table workflow_round drop column if exists agent_type;

-- (d) The tables. No view selects `agent_type` (a dependent view would refuse the drop above).
drop table if exists agent_default;
drop table if exists user_executor_default;
