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
 * What a session report says beyond the id. `agent` is the telemetry identity of the run
 * (first name wins). `observed` is true only for evidence the process ran — a live sample, a
 * readout of a finished run — and false for a report made before the launch, which a refused
 * start can still follow.
 */
export interface SessionEvidence {
    agent?: string | null;
    observed?: boolean;
}

/**
 * A driver or reporter named a session of the job's CURRENT claim (the caller has already proven
 * the lease and holds the job row's lock). The association is kept idempotently: a repeat only
 * advances `last_seen_at`, a `resumed`-claim inference becomes `reported`, and nothing here ever
 * deletes one — clearing the job's session pointer leaves history alone. Only `observed` evidence
 * moves the launch (`requested`/`unknown` -> `observed`, never from a later state): a report made
 * before the spawn proves nothing, and a refused start must stay refusable. The telemetry `agent`
 * is filled once. The execution row is written only when one of those changes. A claim with no
 * execution row (claimed before 085) records nothing: no invention.
 */
export async function recordReportedSession(
    tx: TransactionSql,
    orgId: string,
    jobId: string,
    evidence: SessionEvidence & { sessionId: string }
): Promise<void> {
    const { sessionId } = evidence;
    const agent = evidence.agent ?? null;
    const observed = evidence.observed === true;
    await tx`
        with held as (
            select org_id, id, claim_seq from job where org_id = ${orgId} and id = ${jobId}
        ),
        advanced as (
            update job_execution e set
                launch = case when ${observed}::boolean and e.launch in ('requested', 'unknown')
                              then 'observed' else e.launch end,
                agent = coalesce(e.agent, ${agent}::text),
                updated_at = now()
            from held j
            where e.org_id = j.org_id and e.job_id = j.id and e.claim_seq = j.claim_seq
              and ((${observed}::boolean and e.launch in ('requested', 'unknown'))
                   or (e.agent is null and ${agent}::text is not null))
        )
        insert into job_execution_session (org_id, job_id, claim_seq, session_id, agent, origin)
        select j.org_id, j.id, j.claim_seq, ${sessionId}, ${agent}::text, 'reported'
        from held j
        where exists (
            select 1 from job_execution e
            where e.org_id = j.org_id and e.job_id = j.id and e.claim_seq = j.claim_seq
        )
        on conflict (org_id, job_id, claim_seq, session_id) do update set
            origin = 'reported',
            agent = coalesce(job_execution_session.agent, excluded.agent),
            last_seen_at = now()
    `;
}

/**
 * What an interruption proves about the claim it ends or adopts (issue #845). `refused`: the
 * runner never started, so the claim's launch is `refused`. `adopts`: this claim adopted the
 * runner of that earlier claim — it is `adopted`, linked to the original, and creates no
 * execution of its own. Only a `requested` launch moves (a launched attempt stays `observed`),
 * and an adoption naming a claim not before its own is recorded as nothing: attribution never
 * fails the recovery it describes. The caller holds the job row's lock and has proven the lease.
 */
export async function recordLaunchOutcome(
    tx: TransactionSql,
    orgId: string,
    jobId: string,
    claimSeq: string | number,
    outcome: { refused: true } | { adopts: number }
): Promise<void> {
    if ('refused' in outcome) {
        await tx`
            update job_execution set launch = 'refused', updated_at = now()
            where org_id = ${orgId} and job_id = ${jobId} and claim_seq = ${claimSeq} and launch = 'requested'
        `;
        return;
    }
    await tx`
        update job_execution set launch = 'adopted', adopts_claim_seq = ${outcome.adopts}, updated_at = now()
        where org_id = ${orgId} and job_id = ${jobId} and claim_seq = ${claimSeq} and launch = 'requested'
          and ${outcome.adopts}::bigint < claim_seq
    `;
}
