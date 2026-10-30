-- A running task asks for a connection (BEL-174): the requirement row it opens carries who asked and under which
-- claim, how it closed, and which claim was told. Expand only (docs/persistence.md): every new column is nullable or
-- defaulted, so a pod of the previous release keeps reading and writing the table. This file must contain NO
-- `create extension`, per 005's header.

alter table job_integration_requirement drop constraint if exists job_integration_requirement_reason_check;
alter table job_integration_requirement add constraint job_integration_requirement_reason_check
    check (reason in ('missing', 'ambiguous', 'reconnect'));

alter table job_integration_requirement
    add column if not exists source text not null default 'create',
    add column if not exists outcome text,
    add column if not exists closed_by uuid,
    add column if not exists asked_job_id uuid,
    add column if not exists asked_claim_seq bigint,
    add column if not exists delivered_claim_seq bigint;

alter table job_integration_requirement drop constraint if exists job_integration_requirement_source_check;
alter table job_integration_requirement add constraint job_integration_requirement_source_check
    check (source in ('create', 'runtime'));
alter table job_integration_requirement drop constraint if exists job_integration_requirement_outcome_check;
alter table job_integration_requirement add constraint job_integration_requirement_outcome_check
    check (outcome in ('bound', 'dismissed'));
alter table job_integration_requirement drop constraint if exists job_integration_requirement_asked_check;
alter table job_integration_requirement add constraint job_integration_requirement_asked_check
    check ((source = 'runtime') = (asked_job_id is not null));

-- The job whose OAuth return binds the task (slice 2 writes it; null for every authorization that has none).
alter table integration_authorization add column if not exists bind_job_id uuid;
