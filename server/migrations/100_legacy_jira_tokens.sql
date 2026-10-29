-- Legacy Jira API-token connections end (BEL-61). Jira is reached through an OAuth grant now; nothing lists, binds or
-- serves a `legacy_api_token` row, and a task never takes another identity in its place. Data only, no schema
-- contract: the `credential` check, `kind`, `email not null` and the 094 triggers stay until the contract release
-- (BEL-158). Each statement names its rows by an explicit predicate. This file must contain NO `create extension`,
-- per 005's header.

-- 1. A queued root bound to a still-active legacy connection waits as an open requirement: the claim never offers it
--    and spends no attempt, and the member connects Jira and binds it (`POST /api/jobs/:id/connections`). A running
--    root is left alone: its helper finds no OAuth connection and stops with the connect guidance.
insert into job_integration_requirement (org_id, root_job_id, provider, reason)
select distinct j.org_id, j.root_job_id, 'jira', 'missing'
from job j
join job_connection_binding b on b.org_id = j.org_id and b.root_job_id = j.root_job_id and b.provider = 'jira'
join connector_connection c on c.id = b.connection_id and c.org_id = b.org_id
where j.id = j.root_job_id and j.status = 'queued'
  and c.credential = 'legacy_api_token' and c.status = 'active'
on conflict do nothing;

-- 2. Every active legacy row is disconnected and every legacy token is scrubbed, disconnected rows included.
update connector_connection
set status = 'disconnected', disconnected_at = now(), api_token = null
where credential = 'legacy_api_token' and status = 'active';

update connector_connection
set api_token = null
where credential = 'legacy_api_token' and api_token is not null;

-- 3. The rollout projection an old pod reads no longer points at a legacy row.
update job
set jira_connection_id = null
where jira_connection_id in (select id from connector_connection where credential = 'legacy_api_token');
