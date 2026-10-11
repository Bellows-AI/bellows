-- Batch acceptance (issue #580): the durable evidence a task's gate passed.
--
--   batch_acceptance  one row per accepted attempt of a task. `kind` 'pr_merged' is written by the
--                 reconcile pass from a recorded PR (job_pr) and its observed merge (pr_merge),
--                 both matched on (org, repo, PR number) — never on a number alone — and carries
--                 that PR's identity. `kind` 'accepted' is a person's recorded acceptance of a task
--                 whose plan completion is `accepted`, and carries who. A gate only becomes
--                 'passed' together with one of these rows.
--
-- This file must contain NO `create extension`, per 005's header.

create table if not exists batch_acceptance (
    org_id      text        not null,
    batch_id    uuid        not null,
    task_key    text        not null,
    attempt     int         not null,
    kind        text        not null,
    accepted_by uuid references app_user (id) on delete set null,
    repo        text,
    pr_number   integer,
    pr_url      text,
    recorded_at timestamptz not null default now(),
    constraint batch_acceptance_pk primary key (org_id, batch_id, task_key, attempt),
    constraint batch_acceptance_kind_ck check (kind in ('accepted', 'pr_merged')),
    constraint batch_acceptance_shape_ck check (
        (kind = 'accepted' and repo is null and pr_number is null and pr_url is null)
        or (kind = 'pr_merged' and accepted_by is null and repo is not null and pr_number is not null
            and pr_url is not null)
    ),
    constraint batch_acceptance_attempt_fk foreign key (org_id, batch_id, task_key, attempt)
        references batch_attempt (org_id, batch_id, task_key, attempt) on delete cascade
);
