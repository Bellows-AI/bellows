-- The attempt's telemetry export credential (docs/telemetry.md): the claim hands it to the driver, which gives it with
-- the job id to the runner's CLI as the `x-factory-job-id` + `x-factory-ingest-token` OTLP headers. The CLI's
-- environment is fixed when its container is created, so unlike `lease_token` no claim rotates this one: an adoption
-- of a surviving runner keeps exporting under it. Only ever compared by
-- server/src/db/jobs/job-store-org-resolvers.ts, never exported. This file must contain NO `create extension`, per
-- 005's header.
--
-- The column is added with no default, so the add is a catalog change and no table rewrite (a volatile default in the
-- `add` would rewrite every row under the boot lock). New rows take their token from the default set apart. Of the
-- existing rows only an unfinished one can still be claimed, and those are backfilled here in bounded batches; a claim
-- also fills any row still without one (job-store-claim.ts), so a finished row stays null and never resolves. The
-- column becomes `not null` a release later, once no running code can leave it unset (docs/persistence.md).

alter table job add column if not exists ingest_token uuid;
alter table job alter column ingest_token set default gen_random_uuid();

do $$
declare
    filled integer;
begin
    loop
        update job set ingest_token = gen_random_uuid()
        where id in (
            select id from job where ingest_token is null and finished_at is null limit 1000
        );
        get diagnostics filled = row_count;
        exit when filled = 0;
    end loop;
end
$$;
