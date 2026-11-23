-- The forge start gate's runtime wait: a queued continuation whose starter holds no live grant for the repo's forge
-- waits as an open `forge` requirement (docs/connections.md). `starter-removed` is the reason when the thread's
-- starter no longer exists, so no grant can ever be reconnected for it. Expand only (docs/persistence.md): the new
-- reason is accepted by the widened check, and a pod of the previous release never writes it. This file must contain NO
-- `create extension`, per 005's header.

alter table job_integration_requirement drop constraint if exists job_integration_requirement_reason_check;
alter table job_integration_requirement add constraint job_integration_requirement_reason_check
    check (reason in ('missing', 'ambiguous', 'reconnect', 'starter-removed'));
