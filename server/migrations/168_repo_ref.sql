-- Forge-neutral repository identity: every repo-bearing table gains `forge` and `host`, so a
-- repository is the triple (forge, host, path) and GitLab nested groups and the same path on two hosts fit.
-- Existing rows are GitHub on github.com, which the constant defaults say.
--
-- EXPAND-ONLY (docs/persistence.md): no column is dropped, renamed or made nullable-to-not-null, every new column
-- is `not null` with a constant default (metadata-only on PG >= 11), every check is `not valid` (new writes are
-- held to it, existing rows all hold the default). Every existing key and index stays as it is, beside a new wide
-- one, because a previous-release pod runs against this schema mid-rollout and after a rollback: tracked_repo_pk,
-- env_var_key_uk, workflow_name_uk, pr_follow_pk, pr_merge_pk (its `on conflict (org_id, repo, pr_number)`),
-- batch_merge_slot_idx and job_admission_repo_uk. The contract migration (one release later) drops those, the
-- defaults and tracked_repo.owner/name. Until then one path on two hosts still collides in them.
--
-- The wide indexes on tables that grow (job, pr_merge, pr_follow, batch_merge) are built outside this transaction:
-- migrations/concurrent/168_repo_ref_indexes.sql.
--
-- `path` stays in the existing `repo` column (tracked_repo: owner/name, env_var and workflow: repo_owner/repo_name)
-- until then. Left out by design: session_branch, github_delivery, transcript_tool_event.pr_repo and
-- notification_subscription.repos.
--
-- This file must contain NO `create extension`, per 005's header.

alter table job
    add column if not exists forge text not null default 'github',
    add column if not exists host text not null default 'github.com';
alter table job add constraint job_forge_ck check (forge in ('github', 'gitlab')) not valid;

alter table task_reclaim
    add column if not exists forge text not null default 'github',
    add column if not exists host text not null default 'github.com';
alter table task_reclaim add constraint task_reclaim_forge_ck check (forge in ('github', 'gitlab')) not valid;

alter table env_var
    add column if not exists forge text not null default 'github',
    add column if not exists host text not null default 'github.com';
alter table env_var add constraint env_var_forge_ck check (forge in ('github', 'gitlab')) not valid;

alter table workflow
    add column if not exists forge text not null default 'github',
    add column if not exists host text not null default 'github.com';
alter table workflow add constraint workflow_forge_ck check (forge in ('github', 'gitlab')) not valid;

alter table tracked_repo
    add column if not exists forge text not null default 'github',
    add column if not exists host text not null default 'github.com';
alter table tracked_repo add constraint tracked_repo_forge_ck check (forge in ('github', 'gitlab')) not valid;

alter table job_pr
    add column if not exists forge text not null default 'github',
    add column if not exists host text not null default 'github.com';
alter table job_pr add constraint job_pr_forge_ck check (forge in ('github', 'gitlab')) not valid;

alter table workflow_wait
    add column if not exists forge text not null default 'github',
    add column if not exists host text not null default 'github.com';
alter table workflow_wait add constraint workflow_wait_forge_ck check (forge in ('github', 'gitlab')) not valid;

alter table workflow_round
    add column if not exists forge text not null default 'github',
    add column if not exists host text not null default 'github.com';
alter table workflow_round add constraint workflow_round_forge_ck check (forge in ('github', 'gitlab')) not valid;

alter table pr_merge
    add column if not exists forge text not null default 'github',
    add column if not exists host text not null default 'github.com';
alter table pr_merge add constraint pr_merge_forge_ck check (forge in ('github', 'gitlab')) not valid;

alter table batch_target
    add column if not exists forge text not null default 'github',
    add column if not exists host text not null default 'github.com';
alter table batch_target add constraint batch_target_forge_ck check (forge in ('github', 'gitlab')) not valid;

alter table batch_attempt
    add column if not exists forge text not null default 'github',
    add column if not exists host text not null default 'github.com';
alter table batch_attempt add constraint batch_attempt_forge_ck check (forge in ('github', 'gitlab')) not valid;

alter table batch_acceptance
    add column if not exists forge text not null default 'github',
    add column if not exists host text not null default 'github.com';
alter table batch_acceptance add constraint batch_acceptance_forge_ck check (forge in ('github', 'gitlab')) not valid;

alter table batch_pr_observation
    add column if not exists forge text not null default 'github',
    add column if not exists host text not null default 'github.com';
alter table batch_pr_observation add constraint batch_pr_observation_forge_ck check (forge in ('github', 'gitlab')) not valid;

alter table batch_merge
    add column if not exists forge text not null default 'github',
    add column if not exists host text not null default 'github.com';
alter table batch_merge add constraint batch_merge_forge_ck check (forge in ('github', 'gitlab')) not valid;

alter table pr_follow
    add column if not exists forge text not null default 'github',
    add column if not exists host text not null default 'github.com';
alter table pr_follow add constraint pr_follow_forge_ck check (forge in ('github', 'gitlab')) not valid;

alter table job_execution
    add column if not exists forge text not null default 'github',
    add column if not exists host text not null default 'github.com';
alter table job_execution add constraint job_execution_forge_ck check (forge in ('github', 'gitlab')) not valid;

alter table job_pr_operation
    add column if not exists forge text not null default 'github',
    add column if not exists host text not null default 'github.com';
alter table job_pr_operation add constraint job_pr_operation_forge_ck check (forge in ('github', 'gitlab')) not valid;

alter table notification_event
    add column if not exists forge text not null default 'github',
    add column if not exists host text not null default 'github.com';
alter table notification_event add constraint notification_event_forge_ck check (forge in ('github', 'gitlab')) not valid;

-- tracked_repo: a surrogate id and the full path. The path is a stored generated column, which rewrites this small
-- table (one row per selected repository). The id takes no default in its `add` (migrations-rewrite.test.ts): the
-- default for new rows is set apart and the few existing rows are backfilled. It stays nullable here, as a column
-- the previous release writes without; `set not null` and the primary key are the contract's.
alter table tracked_repo
    add column id uuid,
    add column path text generated always as (owner || '/' || name) stored;
alter table tracked_repo alter column id set default gen_random_uuid();
update tracked_repo set id = gen_random_uuid() where id is null;
create unique index tracked_repo_id_uk on tracked_repo (id);
alter table tracked_repo add constraint tracked_repo_ref_uk unique (org_id, forge, host, path);

-- env_var and workflow: the scope's uniqueness by forge and host, beside the narrow indexes. Both tables are small.
create unique index env_var_ref_uk on env_var (
    org_id,
    forge,
    host,
    coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(repo_owner, ''),
    coalesce(repo_name, ''),
    name
);
create unique index workflow_ref_uk on workflow (
    org_id,
    forge,
    host,
    coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(repo_owner, ''),
    coalesce(repo_name, ''),
    name
);
