-- Forge-neutral repository identity (BEL-532a): every repo-bearing table gains `forge` and `host`, so a
-- repository is the triple (forge, host, path) and GitLab nested groups and the same path on two hosts fit.
-- Existing rows are GitHub on github.com, which the constant defaults say.
--
-- EXPAND-ONLY (docs/persistence.md): no column is dropped, renamed or made nullable-to-not-null, every new column
-- is `not null` with a constant default (metadata-only on PG >= 11), every check is `not valid` (new writes are
-- held to it, existing rows all hold the default), and the narrow keys the previous release infers or relies on
-- stay: pr_merge_pk (its `on conflict (org_id, repo, pr_number)`), batch_merge_slot_idx and job_admission_repo_uk.
-- The contract migration (BEL-562, one release later) drops those, the defaults and tracked_repo.owner/name.
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

-- tracked_repo: a surrogate id, the full path, and identity by (org, forge, host, path). Small table (one row per
-- selected repository), so the rewrite the volatile default and the stored column cause is brief. The previous
-- release deletes and inserts with no conflict target, so the new keys cannot trip it.
alter table tracked_repo
    add column id uuid not null default gen_random_uuid(),
    add column path text generated always as (owner || '/' || name) stored;
alter table tracked_repo drop constraint tracked_repo_pk;
alter table tracked_repo add primary key (id);
alter table tracked_repo add constraint tracked_repo_ref_uk unique (org_id, forge, host, path);

-- env_var and workflow: the scope's uniqueness gains the forge and host. Neither store has an `on conflict`.
drop index if exists env_var_key_uk;
create unique index env_var_key_uk on env_var (
    org_id,
    forge,
    host,
    coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(repo_owner, ''),
    coalesce(repo_name, ''),
    name
);
drop index if exists workflow_name_uk;
create unique index workflow_name_uk on workflow (
    org_id,
    forge,
    host,
    coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(repo_owner, ''),
    coalesce(repo_name, ''),
    name
);

-- pr_follow: its only insert is `on conflict do nothing` with no target, so the key can widen now.
alter table pr_follow drop constraint pr_follow_pk;
alter table pr_follow add primary key (org_id, forge, host, repo, pr_number);

-- pr_merge keeps pr_merge_pk; the wide key is a unique index beside it.
create unique index pr_merge_ref_uk on pr_merge (org_id, forge, host, repo, pr_number);

-- The wide merge slot, beside the narrow one (which is stricter, so the slot stays exclusive).
create unique index batch_merge_ref_slot_idx
    on batch_merge (org_id, forge, lower(host), (case when forge = 'github' then lower(repo) else repo end), target_branch)
    where state in ('dispatching', 'uncertain');

-- The wide admission slot, beside job_admission_repo_uk.
create unique index job_admission_repo_ref_uk on job (org_id, forge, host, repo, admission_slot_repo)
    where status = 'running' and review_of is null and admission_slot_repo is not null;
