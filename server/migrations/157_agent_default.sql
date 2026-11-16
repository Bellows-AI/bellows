-- The agent default (docs/workspace.md): the agent and model a task runs on when it names no executor profile and the
-- member's stored executor preference does not resolve. One row for the organization (`user_id` null, written by an
-- admin) and one per member; the two partial unique indexes hold "at most one of each".
create table if not exists agent_default (
    org_id     text not null,
    user_id    uuid,
    agent_type text not null,
    model      text not null,
    updated_at timestamptz not null default now(),

    constraint agent_default_org_fk foreign key (org_id)
        references organization (id) on update cascade on delete cascade,
    constraint agent_default_user_fk foreign key (user_id)
        references app_user (id) on delete cascade,
    constraint agent_default_type_ck check (agent_type in ('claude-code', 'opencode')),
    constraint agent_default_model_ck check (char_length(model) between 1 and 200)
);
create unique index if not exists agent_default_org_row on agent_default (org_id) where user_id is null;
create unique index if not exists agent_default_member_row on agent_default (org_id, user_id) where user_id is not null;

-- The policy 151 gave every org table.
alter table agent_default enable row level security;
drop policy if exists org_isolation on agent_default;
create policy org_isolation on agent_default using (org_id = current_setting('app.org_id', true))
    with check (org_id = current_setting('app.org_id', true));

-- A task resolved to an agent default is frozen with it: the job, a batch's plan task and a parked workflow round
-- carry the agent and model, so a claim, retry, takeover or wake never re-reads `agent_default`. Nullable columns with
-- no default are metadata only. The type checks are NOT VALID — every existing row holds null — so no table is scanned
-- under the boot lock; every later write is checked. `agent_model` is not tied to `agent_type`: a profile-based task
-- may carry a model alone.
alter table job
    add column if not exists agent_type text,
    add column if not exists agent_model text;
alter table job drop constraint if exists job_agent_type_ck;
alter table job add constraint job_agent_type_ck check (agent_type in ('claude-code', 'opencode')) not valid;

alter table batch_task
    add column if not exists agent_type text,
    add column if not exists agent_model text;
alter table batch_task drop constraint if exists batch_task_agent_type_ck;
alter table batch_task add constraint batch_task_agent_type_ck
    check (agent_type in ('claude-code', 'opencode')) not valid;

alter table workflow_round
    add column if not exists agent_type text,
    add column if not exists agent_model text;
alter table workflow_round drop constraint if exists workflow_round_agent_type_ck;
alter table workflow_round add constraint workflow_round_agent_type_ck
    check (agent_type in ('claude-code', 'opencode')) not valid;
