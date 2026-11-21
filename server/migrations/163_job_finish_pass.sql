-- Finish passes: one row per finish pass the driver answered while the agent was still in its run — the declared
-- gates run when the agent says it is done, and a red pass sends it back to work — written under the attempt's
-- lease, so the rounds a job row has spent survive a takeover and are never read from a driver's memory.
--
--   pass_id        minted by the driver per pass; the replay key. A replay changes nothing.
--   run_claim_seq  the claim that ran the agent: the run the pass belongs to.
--   claim_seq      the claim of the driver that wrote the row.
--   verdict        passed | failed. A pass that never ran (refused, capped, interrupted) writes no row.
--   gate           the first gate that failed; null on a passed pass.
--
-- The rounds a job row has spent are the count of its `failed` rows across every claim of it; another row of the
-- thread (a follow-up, a successor) starts at none. Removing a thread, expiring it or purging its organization
-- deletes the rows.
--
-- The cap those rounds are held to is the thread root's `gate_fix_rounds` (162), now frozen on every root whatever
-- its mode: a root that carries none — a workflow root, a root from before 162, one that resolved no profile — gets
-- the default (`DEFAULT_GATE_FIX_ROUNDS`, 3), and a root can no longer be stored without one. The column default
-- covers an insert that does not name it; an explicit null on a root is refused.
--
-- A gate run of a finish pass is recorded in `job_gate_run` under its own source, `finish`.
--
-- This file must contain NO `create extension`, per 005's header.

create table if not exists job_finish_pass (
    org_id        text not null,
    job_id        uuid not null,
    pass_id       uuid not null,
    run_claim_seq bigint not null,
    claim_seq     bigint not null,
    verdict       text not null check (verdict in ('passed', 'failed')),
    gate          text,
    created_at    timestamptz not null default now(),
    primary key (org_id, job_id, pass_id),
    constraint job_finish_pass_org_fk foreign key (org_id) references organization (id)
        on update cascade on delete cascade,
    foreign key (org_id, job_id) references job (org_id, id) on delete cascade
);

-- The policy 151 gave every org table.
alter table job_finish_pass enable row level security;
drop policy if exists org_isolation on job_finish_pass;
create policy org_isolation on job_finish_pass using (org_id = current_setting('app.org_id', true))
    with check (org_id = current_setting('app.org_id', true));

alter table job_gate_run drop constraint if exists job_gate_run_source_check;
alter table job_gate_run add constraint job_gate_run_source_check
    check (source in ('adhoc', 'completion', 'finish'));

update job set gate_fix_rounds = 3 where id = root_job_id and gate_fix_rounds is null;
alter table job alter column gate_fix_rounds set default 3;
alter table job drop constraint if exists job_root_gate_fix_rounds_ck;
alter table job add constraint job_root_gate_fix_rounds_ck check (id <> root_job_id or gate_fix_rounds is not null);
