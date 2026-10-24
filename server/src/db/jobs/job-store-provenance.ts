import type { TransactionSql } from 'postgres';

/**
 * Execution provenance (issue #845): the durable record of a claim, written in the claim's own
 * transaction so a claim and its record commit or roll back together. Rows live in
 * `job_execution` / `job_execution_session` (085) with no foreign key to the job: removing a task
 * never erases them.
 *
 * Reads the post-claim job row, so the one statement serves a task claim and a review lease alike.
 * Idempotent on `(org_id, job_id, claim_seq)`: a claim handed back again records nothing twice.
 * A session the row still carries after the claim is the one the runner resumes; the board
 * infers it here, because the driver reports nothing for a resume.
 */
export async function recordExecution(tx: TransactionSql, orgId: string, jobId: string): Promise<void> {
    await tx`
        with created as (
            insert into job_execution (
                org_id, job_id, claim_seq, root_job_id, requesting_job_id, requesting_root_job_id,
                author_id, repo, executor, executor_scope, resumed
            )
            select j.org_id, j.id, j.claim_seq, j.root_job_id, j.review_of, r.root_job_id,
                   j.created_by, j.repo, j.executor, j.executor_scope, j.session_id is not null
            from job j
            left join job r on r.org_id = j.org_id and r.id = j.review_of
            where j.org_id = ${orgId} and j.id = ${jobId}
            on conflict (org_id, job_id, claim_seq) do nothing
            returning org_id, job_id, claim_seq
        )
        -- Only the claim that creates the record infers: a claim handed back again may carry a
        -- session its own run has reported since, which is not an inference.
        insert into job_execution_session (org_id, job_id, claim_seq, session_id, origin)
        select j.org_id, j.id, j.claim_seq, j.session_id, 'inferred_at_claim'
        from created c
        join job j on j.org_id = c.org_id and j.id = c.job_id
        where j.session_id is not null
    `;
}

/**
 * A driver or reporter named a session of the job's CURRENT claim (the caller has already proven
 * the lease). The association is kept idempotently: a repeat only advances `last_seen_at`, a
 * `resumed`-claim inference becomes `reported`, and nothing here ever deletes one — clearing the
 * job's session pointer leaves history alone. The first report also proves the process launched
 * (`requested`/`unknown` -> `observed`, never from a later state) and fills the telemetry `agent`
 * once. A claim with no execution row (claimed before 085) records nothing: no invention.
 */
export async function recordReportedSession(
    tx: TransactionSql,
    orgId: string,
    jobId: string,
    session: { sessionId: string; agent: string | null }
): Promise<void> {
    const { sessionId, agent } = session;
    await tx`
        with execution as (
            update job_execution e set
                launch = case when e.launch in ('requested', 'unknown') then 'observed' else e.launch end,
                agent = coalesce(e.agent, ${agent}),
                updated_at = now()
            from job j
            where e.org_id = j.org_id and e.job_id = j.id and e.claim_seq = j.claim_seq
              and j.org_id = ${orgId} and j.id = ${jobId}
            returning e.org_id, e.job_id, e.claim_seq
        )
        insert into job_execution_session (org_id, job_id, claim_seq, session_id, agent, origin)
        select org_id, job_id, claim_seq, ${sessionId}, ${agent}, 'reported' from execution
        on conflict (org_id, job_id, claim_seq, session_id) do update set
            origin = 'reported',
            agent = coalesce(job_execution_session.agent, excluded.agent),
            last_seen_at = now()
    `;
}
