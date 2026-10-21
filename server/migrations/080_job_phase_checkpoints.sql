-- Phase checkpoints (issue #829): the post-run phases of an attempt — gates, post-run helpers,
-- publish — leave their outcome here under the attempt's lease, so the driver that adopts or takes
-- over the run resumes after the last phase that finished instead of running every one again.
-- Written only after a phase returns, so a phase that started and did not finish has no row.
--
--   run_claim_seq  the claim that ran the agent: the run the phases belong to. A takeover or an
--                  adopter writes under its own claim but names the run it resumed.
--   phase          gates < post < publish. Writing a phase drops the later phases of the same run.
--   claim_seq      the claim of the driver that wrote the row.
--   tree           the tree fingerprint the gates ran against; null where the phase has none.
--   result         the phase's outcome, as the driver would have recomputed it.
--
-- Removing a thread deletes its rows, and their checkpoints with them.
--
-- This file must contain NO `create extension`, per 005's header.

create table if not exists job_phase_checkpoint (
    org_id        text not null,
    job_id        uuid not null,
    run_claim_seq bigint not null,
    phase         text not null check (phase in ('gates', 'post', 'publish')),
    claim_seq     bigint not null,
    tree          text,
    result        jsonb not null,
    created_at    timestamptz not null default now(),
    primary key (org_id, job_id, run_claim_seq, phase),
    foreign key (org_id, job_id) references job (org_id, id) on delete cascade
);
