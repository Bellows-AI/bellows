-- The attempt's telemetry export credential (docs/telemetry.md): the claim hands it to the driver, which gives it with
-- the job id to the runner's CLI as the `x-factory-job-id` + `x-factory-ingest-token` OTLP headers. The CLI's
-- environment is fixed when its container is created, so unlike `lease_token` no claim rotates this one: an adoption
-- of a surviving runner keeps exporting under it. Only ever compared by
-- server/src/db/jobs/job-store-org-resolvers.ts, never exported. This file must contain NO `create extension`, per
-- 005's header.
--
-- Metadata only, no row touched: the boot applies every pending file in one transaction, so a backfill here would hold
-- the add's exclusive lock for its whole length. The add has no default, so it is a catalog change (no rewrite); the
-- default set apart applies to rows inserted from now on (no rewrite either). An existing row stays null until its
-- next claim — a takeover included — fills it (job-store-claim.ts, job-store-reviews.ts); a null never matches a
-- presented token, so such a row's exports are refused until then. Rows never claimed again (finished ones) stay null,
-- so the column does not become `not null` until a later data migration fills them (docs/persistence.md).

alter table job add column if not exists ingest_token uuid;
alter table job alter column ingest_token set default gen_random_uuid();
