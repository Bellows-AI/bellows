-- Gate runs (issue #983): one row per gate EXECUTION of an attempt, written under its lease — a
-- `running` row before the gate starts, replaced by its terminal row when it ends — so the
-- completion pass (and another driver after a takeover) can tell a verified pass of the unchanged
-- tree from a stale one instead of running every gate again.
--
--   execution_id   minted by the driver per execution; the replay key. A row only ever moves
--                  running -> terminal, and the first terminal row wins.
--   seq            assigned at the running row's insert, inside the driver's per-checkout queue and
--                  before the gate executes: the order the gates ran in. The LATEST row of a gate —
--                  of any scope — is the one a reuse decision reads.
--   run_claim_seq  the claim that ran the agent: the run the row belongs to. A takeover writes and
--                  reads under its own claim but names the run it resumed.
--   claim_seq      the claim of the driver that wrote the row.
--   identity       HMAC-SHA256 hex of the gate's configuration (command, timeout, image, setup,
--                  cache, services, env values); never a raw value.
--   filtered       the ad-hoc call narrowed the run with a filter: a partial answer, never a pass.
--   source         adhoc (the agent's call) | completion (the end-of-run pass).
--   outcome        running | passed | failed | setup_failed (the gate never ran) | not_started |
--                  incomplete (it started and its result was lost).
--   tree_before / tree_after / mutated_since
--                  the tree fingerprints around the run and whether a shipped path was touched while
--                  it ran; null where a probe could not tell.
--
-- Removing a thread deletes its rows.
--
-- This file must contain NO `create extension`, per 005's header.

create table if not exists job_gate_run (
    org_id        text not null,
    job_id        uuid not null,
    execution_id  uuid not null,
    seq           bigint generated always as identity,
    run_claim_seq bigint not null,
    claim_seq     bigint not null,
    gate          text not null,
    identity      text not null,
    filtered      boolean not null,
    source        text not null check (source in ('adhoc', 'completion')),
    outcome       text not null check (outcome in ('running', 'passed', 'failed', 'setup_failed', 'not_started', 'incomplete')),
    exit_code     integer,
    tree_before   text,
    tree_after    text,
    mutated_since boolean,
    started_at    timestamptz,
    finished_at   timestamptz,
    created_at    timestamptz not null default now(),
    primary key (org_id, job_id, execution_id),
    foreign key (org_id, job_id) references job (org_id, id) on delete cascade
);

create index if not exists job_gate_run_latest on job_gate_run (org_id, job_id, run_claim_seq, gate, seq desc);
