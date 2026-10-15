-- How long the attempt's `.bellows.yaml` `environment.setup` ran before the agent started (issue
-- #733), reported by the driver on the verdict — the time the task view shows apart from the
-- agent's. It is part of the run's wall clock (`wall_clock_ms`), never added to it.
--
-- Nullable: null is "no setup ran" (none declared, or the attempt never reached it), and the
-- verdict overwrites it like `agent_turns`, so a retry never inherits a killed attempt's figure.
-- bigint milliseconds, the wall clock's unit.
alter table job add column if not exists setup_ms bigint;
