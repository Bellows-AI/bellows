-- Built after the schema transaction commits (migrate.ts), on every boot: `if not exists` makes a built index a no-op
-- and an invalid leftover of a crashed build is dropped and rebuilt. Each sits beside the narrow key it will replace.

-- pr_merge and pr_follow: the wide keys, beside pr_merge_pk and pr_follow_pk.
create unique index concurrently if not exists pr_merge_ref_uk on pr_merge (org_id, forge, host, repo, pr_number);
create unique index concurrently if not exists pr_follow_ref_uk on pr_follow (org_id, forge, host, repo, pr_number);

-- The wide merge slot, beside batch_merge_slot_idx (stricter, so the slot stays exclusive).
create unique index concurrently if not exists batch_merge_ref_slot_idx
    on batch_merge (org_id, forge, lower(host), (case when forge = 'github' then lower(repo) else repo end), target_branch)
    where state in ('dispatching', 'uncertain');

-- The wide admission slot, beside job_admission_repo_uk.
create unique index concurrently if not exists job_admission_repo_ref_uk
    on job (org_id, forge, host, repo, admission_slot_repo)
    where status = 'running' and review_of is null and admission_slot_repo is not null;
