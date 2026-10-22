-- Shared admission budgets (issue #831): the slot a running row holds in each budget its claim
-- admitted it under. Occupancy is the running rows themselves, so a row that ends frees its slots
-- by leaving the indexes' predicate and no counter can leak.
--
--   admission_slot_global  1..ADMISSION_MAX_RUNNING across every org; null when unbudgeted.
--   admission_slot_org     1..ADMISSION_MAX_RUNNING_PER_ORG within the row's org.
--   admission_slot_repo    1..ADMISSION_MAX_RUNNING_PER_REPO within the row's org and repo.
--
-- The unique indexes are the backstop to the claim's slot try-locks: two running rows never hold
-- one slot. Reviews (`review_of`) are leased to their caller's claim and never budgeted.
--
-- This file must contain NO `create extension`, per 005's header.

alter table job add column if not exists admission_slot_global int;
alter table job add column if not exists admission_slot_org int;
alter table job add column if not exists admission_slot_repo int;

create unique index if not exists job_admission_global_uk on job (admission_slot_global)
    where status = 'running' and review_of is null and admission_slot_global is not null;
create unique index if not exists job_admission_org_uk on job (org_id, admission_slot_org)
    where status = 'running' and review_of is null and admission_slot_org is not null;
create unique index if not exists job_admission_repo_uk on job (org_id, repo, admission_slot_repo)
    where status = 'running' and review_of is null and admission_slot_repo is not null;

-- What every budget counts: the running non-review rows, by org and repo.
create index if not exists job_admission_running_idx on job (org_id, repo)
    where status = 'running' and review_of is null;
