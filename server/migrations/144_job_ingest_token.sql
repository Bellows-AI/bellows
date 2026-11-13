-- The attempt's telemetry export credential (docs/telemetry.md): the claim hands it to the driver, which renders it with
-- the job id into the runner's root-owned telemetry config as the `x-factory-job-id` + `x-factory-ingest-token`
-- headers. That file is written once, when the container is created, so unlike `lease_token` no claim rotates this
-- one: an adoption of a surviving runner keeps exporting under it. Only ever compared by
-- server/src/db/jobs/job-store-org-resolvers.ts, never exported. This file must contain NO `create extension`, per
-- 005's header.

alter table job add column if not exists ingest_token uuid not null default gen_random_uuid();
