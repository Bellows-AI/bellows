-- The forge start gate's post-run wait: a member who started a task but cannot write to the repository on the forge
-- (the board's PR create answered 403/404 under their user token) waits at publish as an open `forge` requirement with
-- reason `forge-access` (docs/connections.md). Expand only (docs/persistence.md): the new reason is accepted by the
-- widened check, and a pod of the previous release never writes it. This file must contain NO `create extension`, per
-- 005's header. It may be renumbered when it merges; an unmerged migration is safe to rename, a merged one never is.

alter table job_integration_requirement drop constraint if exists job_integration_requirement_reason_check;
alter table job_integration_requirement add constraint job_integration_requirement_reason_check
    check (reason in ('missing', 'ambiguous', 'reconnect', 'starter-removed', 'forge-access'));
