-- Why an observed, ready PR is not being merged yet (docs/batches.md): the merger's refusal of the starter's token (a
-- grant that must be reconnected, a deleted starter, an unread token), as the task's wait note shows it. Written by the
-- merger when it admits no merge for want of a token and cleared when one is admitted; it claims no attempt and parks
-- nothing. Expand only (docs/persistence.md): one nullable column, no backfill, no scan.
-- This file must contain NO `create extension`, per 005's header.
alter table batch_pr_observation add column if not exists merge_wait text;
