-- Per-organization plan limits (docs/commerce.md). The commerce push carries them on `org_plan`; a null column,
-- or no row at all, takes the board's default (PLAN_DEFAULT_MAX_*, the Free plan, required in cloud mode).
--
--   max_running       the most non-review rows running at once for the org, beside ADMISSION_MAX_RUNNING_PER_ORG.
--   max_queued        the most rows queued at once; a create past it is refused naming `queued`.
--   max_wall_seconds  the most wall time one run may bank; the heartbeat then answers stop.
alter table org_plan add column if not exists max_running integer check (max_running > 0);
alter table org_plan add column if not exists max_queued integer check (max_queued > 0);
alter table org_plan add column if not exists max_wall_seconds integer check (max_wall_seconds > 0);

-- Why the board stopped a run on its own, apart from a member's stop (stopped_by) and an infrastructure loss
-- (interruptions): the only cause is the plan's wall time. Null on every other row.
alter table job add column if not exists stop_cause text check (stop_cause in ('wall-time'));

-- When the org was last served: the newest claim's `started_at` (every claim stamps it), read by the cross-org
-- claim order to give an equal share to the org served least recently. One index probe per org per poll.
create index if not exists job_org_last_claim on job (org_id, started_at desc) where review_of is null;
