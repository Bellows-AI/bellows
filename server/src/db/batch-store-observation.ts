import { randomUUID } from 'node:crypto';
import {
    assessPullRequest,
    errorFingerprint,
    GATE_OPEN,
    HOUR,
    isTransientReadError,
    MERGEABLE_UNKNOWN,
    nextObservationDelayMs,
    observationFingerprint,
    PR_CLOSED,
    PR_OPEN,
    sameRepo,
    TASK_SUCCEEDED,
    type CheckEvidence,
    type PrFacts,
    type ReadErrorKind,
} from '@factory-ai/core';
import type { Sql, TransactionSql } from 'postgres';
import { BATCH_STARTED } from './batch-store-types.js';

/**
 * The durable PR observations (063; docs/batches.md). A reader claims a due row under a short
 * lease, reads GitHub with no lock held, and commits only while it still holds the lease and the
 * task is still bound to the PR and attempt it read — so a superseded result (a repair began, the
 * PR was rebound, another replica read first) is dropped before it can write anything.
 */

/** How long a claimed row is the claimant's alone; a reader that dies frees it after this. */
export const OBSERVATION_LEASE_MS = 120_000;

export interface ObservationClaim {
    batchId: string;
    taskKey: string;
    /** The repository the task's thread published to (`job_pr`). */
    repo: string;
    /** The repository the plan targets for the task; a PR elsewhere is a binding error. */
    targetRepo: string;
    prNumber: number;
    attempt: number;
    token: string;
    hintSeq: number;
}

export type ObservationResult =
    | { kind: 'facts'; facts: PrFacts }
    | { kind: 'error'; error: ReadErrorKind; detail: string; retryAfterMs: number | null };

export type CommitOutcome = { status: 'superseded' } | { status: 'committed'; changed: boolean; revision: number };

/** What a consumer (a recovery decision, the report) reads: facts, never a verdict. */
export interface BatchPrObservation {
    taskKey: string;
    repo: string;
    prNumber: number;
    /** The attempt the PR was observed for; a new attempt starts with no observation. */
    attempt: number;
    /** Bumps only when the assessed facts change; act once per fingerprint, not per refresh. */
    revision: number;
    fingerprint: string | null;
    /** Core's ObservationOutcome; null before the first assessment and after a definitive error. */
    outcome: string | null;
    /** A confirmed failing check or conflict on `headSha`. */
    repairable: boolean;
    prState: string | null;
    prUrl: string | null;
    baseBranch: string | null;
    /** The revision the checks ran on. */
    headSha: string | null;
    /** The target revision a conflict was judged against. */
    targetSha: string | null;
    mergeability: string | null;
    checks: string | null;
    review: string | null;
    evidence: readonly CheckEvidence[];
    /** A webhook says something changed that this row has not yet re-read: do not act on it. */
    stale: boolean;
    error: { code: string; detail: string | null } | null;
    observedAt: string | null;
    nextRefreshAt: string;
}

export interface ObservationDeps {
    sql: Sql;
    orgId: string;
    now?: (() => Date) | undefined;
}

const nowOf = (deps: ObservationDeps): Date => (deps.now ? deps.now() : new Date());

/** How long after a cancel or expiry its PRs are still read for a merge; polling forever would spend the rate limit. */
export const FENCED_OBSERVATION_MS = HOUR * 24;

/** Tasks whose PR is worth reading: an unaccepted PR of a live batch, or a fenced one's until merged or the window ends. */
const eligible = (tx: TransactionSql, orgId: string, now: Date) => {
    const fenceCutoff = new Date(now.getTime() - FENCED_OBSERVATION_MS);
    return tx`
    t.org_id = ${orgId} and b.status = ${BATCH_STARTED} and t.root_job_id is not null
    and not exists (
        select 1 from pr_merge m
        where m.org_id = p.org_id and m.repo = p.repo and m.pr_number = p.pr_number
    )
    and (
        (b.cancelled_at is null and b.expired_at is null and b.completed_at is null
         and t.execution = ${TASK_SUCCEEDED} and t.gate = ${GATE_OPEN})
        or ((b.cancelled_at is not null or b.expired_at is not null) and b.completed_at is null
            and coalesce(b.cancelled_at, b.expired_at) > ${fenceCutoff})
    )
`;
};

interface ClaimRow {
    batch_id: string;
    task_key: string;
    repo: string;
    target_repo: string;
    pr_number: number;
    attempt: number;
    hint_seq: string;
}

/**
 * Binds rows to the current PR and attempt, then leases the due ones. Short transactions only:
 * the provider is read after this commits.
 */
export async function claimDue(deps: ObservationDeps, limit: number): Promise<ObservationClaim[]> {
    const { sql, orgId } = deps;
    const now = nowOf(deps);
    return sql.begin(async (tx) => {
        // A row for another PR or an earlier attempt describes something the task no longer is.
        await tx`
            delete from batch_pr_observation o
            where o.org_id = ${orgId} and not exists (
                select 1 from batch_task t
                join job_pr p on p.org_id = t.org_id and p.root_job_id = t.root_job_id
                where t.org_id = o.org_id and t.batch_id = o.batch_id and t.key = o.task_key
                  and p.repo = o.repo and p.pr_number = o.pr_number
                  and o.attempt = (select max(attempt) from batch_attempt
                                   where org_id = t.org_id and batch_id = t.batch_id and task_key = t.key)
            )
        `;
        await tx`
            insert into batch_pr_observation (org_id, batch_id, task_key, repo, pr_number, attempt, next_refresh_at)
            select t.org_id, t.batch_id, t.key, p.repo, p.pr_number, a.attempt, ${now}
            from batch_task t
            join batch b on b.org_id = t.org_id and b.id = t.batch_id
            join job_pr p on p.org_id = t.org_id and p.root_job_id = t.root_job_id
            join lateral (
                select max(attempt)::int as attempt from batch_attempt
                where org_id = t.org_id and batch_id = t.batch_id and task_key = t.key
            ) a on a.attempt is not null
            where ${eligible(tx, orgId, now)}
            on conflict do nothing
        `;
        const due = await tx<ClaimRow[]>`
            select o.batch_id, o.task_key, o.repo, tg.repo as target_repo, o.pr_number, o.attempt,
                   o.hint_seq::text as hint_seq
            from batch_pr_observation o
            join batch_task t on t.org_id = o.org_id and t.batch_id = o.batch_id and t.key = o.task_key
            join batch b on b.org_id = t.org_id and b.id = t.batch_id
            join batch_target tg on tg.org_id = t.org_id and tg.batch_id = t.batch_id and tg.key = t.target_key
            join job_pr p on p.org_id = t.org_id and p.root_job_id = t.root_job_id
            where ${eligible(tx, orgId, now)}
              and o.next_refresh_at <= ${now}
              and (o.claimed_until is null or o.claimed_until <= ${now})
              -- A closed PR of a fenced batch has nothing left to record.
              and not (coalesce(o.pr_state, '') = ${PR_CLOSED}
                       and (b.cancelled_at is not null or b.expired_at is not null))
            order by o.next_refresh_at, o.batch_id, o.task_key
            limit ${limit}
            for update of o skip locked
        `;
        const claimedUntil = new Date(now.getTime() + OBSERVATION_LEASE_MS);
        const claims: ObservationClaim[] = [];
        for (const row of due) {
            const token = randomUUID();
            await tx`
                update batch_pr_observation set claim_token = ${token}::uuid, claimed_until = ${claimedUntil}
                where org_id = ${orgId} and batch_id = ${row.batch_id} and task_key = ${row.task_key}
            `;
            claims.push({
                batchId: row.batch_id,
                taskKey: row.task_key,
                repo: row.repo,
                targetRepo: row.target_repo,
                prNumber: row.pr_number,
                attempt: row.attempt,
                token,
                hintSeq: Number(row.hint_seq),
            });
        }
        return claims;
    });
}

interface LockedObservation {
    revision: string;
    fingerprint: string | null;
    failures: number;
    hint_seq: string;
    latest_attempt: number | null;
    bound_repo: string | null;
    bound_number: number | null;
}

/**
 * Writes what a read found, if the claim still stands. The row lock is the only lock taken, so a
 * scheduler transaction deleting the row for a new attempt waits for this commit and then wins.
 */
export async function commitObservation(
    deps: ObservationDeps,
    claim: ObservationClaim,
    result: ObservationResult
): Promise<CommitOutcome> {
    const { sql, orgId } = deps;
    const now = nowOf(deps);
    return sql.begin(async (tx): Promise<CommitOutcome> => {
        const [row] = await tx<LockedObservation[]>`
            select o.revision::text as revision, o.fingerprint, o.failures, o.hint_seq::text as hint_seq,
                   (select max(attempt)::int from batch_attempt
                    where org_id = o.org_id and batch_id = o.batch_id and task_key = o.task_key) as latest_attempt,
                   p.repo as bound_repo, p.pr_number as bound_number
            from batch_pr_observation o
            left join batch_task t on t.org_id = o.org_id and t.batch_id = o.batch_id and t.key = o.task_key
            left join job_pr p on p.org_id = t.org_id and p.root_job_id = t.root_job_id
            where o.org_id = ${orgId} and o.batch_id = ${claim.batchId} and o.task_key = ${claim.taskKey}
              and o.claim_token = ${claim.token}::uuid
            for update of o
        `;
        const standing =
            row !== undefined &&
            row.latest_attempt === claim.attempt &&
            row.bound_repo === claim.repo &&
            row.bound_number === claim.prNumber;
        if (!standing) return { status: 'superseded' };

        // A hint that arrived during the read may postdate it: the row stays stale and is read again now.
        const stale = Number(row.hint_seq) !== claim.hintSeq;
        const at = { orgId, batchId: claim.batchId, taskKey: claim.taskKey };
        if (result.kind === 'error') return writeError(tx, { at, row, result, now, stale });
        if (!sameRepo(result.facts.repo, claim.repo) || result.facts.number !== claim.prNumber) {
            const mismatch: ObservationResult = {
                kind: 'error',
                error: 'binding',
                detail: `${claim.repo}#${claim.prNumber} resolved to ${result.facts.repo}#${result.facts.number}`,
                retryAfterMs: null,
            };
            return writeError(tx, { at, row, result: mismatch, now, stale });
        }
        return writeFacts(tx, { at, row, facts: result.facts, now, stale });
    });
}

type At = { orgId: string; batchId: string; taskKey: string };

async function writeFacts(
    tx: TransactionSql,
    run: { at: At; row: LockedObservation; facts: PrFacts; now: Date; stale: boolean }
): Promise<CommitOutcome> {
    const { at, row, facts, now, stale } = run;
    const assessment = assessPullRequest(facts);
    const fingerprint = observationFingerprint(facts, assessment);
    const changed = fingerprint !== row.fingerprint;
    const revision = Number(row.revision) + (changed ? 1 : 0);
    const mergeabilityUnknown = assessment.prState === PR_OPEN && assessment.mergeability === MERGEABLE_UNKNOWN;
    const delay = stale ? 0 : nextObservationDelayMs({ ok: true, mergeabilityUnknown });
    await tx`
        update batch_pr_observation
        set revision = ${revision}, fingerprint = ${fingerprint}, outcome = ${assessment.outcome},
            repairable = ${assessment.repairable}, pr_state = ${assessment.prState}, pr_url = ${facts.url},
            base_branch = ${facts.baseBranch}, head_sha = ${facts.headSha}, target_sha = ${facts.targetSha},
            mergeability = ${assessment.mergeability}, checks = ${assessment.checks}, review = ${assessment.review},
            evidence = ${tx.json(assessment.evidence as never)}, stale = ${stale}, error_code = null,
            error_detail = null, failures = 0, observed_at = ${now},
            next_refresh_at = ${new Date(now.getTime() + delay)}, claim_token = null, claimed_until = null,
            updated_at = ${now}
        where org_id = ${at.orgId} and batch_id = ${at.batchId} and task_key = ${at.taskKey}
    `;
    return { status: 'committed', changed, revision };
}

const DETAIL_LIMIT = 500;

async function writeError(
    tx: TransactionSql,
    run: {
        at: At;
        row: LockedObservation;
        result: Extract<ObservationResult, { kind: 'error' }>;
        now: Date;
        stale: boolean;
    }
): Promise<CommitOutcome> {
    const { at, row, result, now, stale } = run;
    const failures = row.failures + 1;
    const delay = nextObservationDelayMs({ ok: false, failures, retryAfterMs: result.retryAfterMs });
    const next = new Date(now.getTime() + delay);
    const detail = result.detail.slice(0, DETAIL_LIMIT);
    const revision = Number(row.revision);
    if (isTransientReadError(result.error)) {
        // The last assessment still describes the PR as last seen; only the failure is news. The
        // backoff holds even when a hint arrived — an event never overrides a rate limit.
        await tx`
            update batch_pr_observation
            set error_code = ${result.error}, error_detail = ${detail}, failures = ${failures},
                next_refresh_at = ${next}, stale = (stale or ${stale}), claim_token = null, claimed_until = null, updated_at = ${now}
            where org_id = ${at.orgId} and batch_id = ${at.batchId} and task_key = ${at.taskKey}
        `;
        return { status: 'committed', changed: false, revision };
    }
    // A definitive failure withdraws the assessment: an inaccessible PR must not read as passing.
    const fingerprint = errorFingerprint(result.error);
    const changed = fingerprint !== row.fingerprint;
    await tx`
        update batch_pr_observation
        set revision = ${revision + (changed ? 1 : 0)}, fingerprint = ${fingerprint}, outcome = null,
            repairable = false, pr_state = null, pr_url = null, base_branch = null, head_sha = null,
            target_sha = null, mergeability = null, checks = null, review = null, evidence = '[]'::jsonb,
            stale = ${stale}, error_code = ${result.error}, error_detail = ${detail}, failures = ${failures},
            observed_at = ${now}, next_refresh_at = ${next}, claim_token = null, claimed_until = null,
            updated_at = ${now}
        where org_id = ${at.orgId} and batch_id = ${at.batchId} and task_key = ${at.taskKey}
    `;
    return { status: 'committed', changed, revision: revision + (changed ? 1 : 0) };
}

/** What a webhook knows about the PR it names: a number, or only the commit a status was posted on. */
export interface RefreshHint {
    repo: string;
    numbers?: readonly number[];
    headSha?: string | null;
}

/**
 * Events are hints, not state: mark the matching rows stale and, unless they are backing off or
 * already leased, due now. The row's own reader does the read, so duplicate events coalesce into one.
 */
export async function requestRefresh(deps: ObservationDeps, hint: RefreshHint): Promise<number> {
    const { sql, orgId } = deps;
    const numbers = [...(hint.numbers ?? [])];
    const sha = hint.headSha ?? null;
    if (numbers.length === 0 && sha === null) return 0;
    const now = nowOf(deps);
    const rows = await sql`
        update batch_pr_observation
        set stale = true, hint_seq = hint_seq + 1, updated_at = ${now},
            next_refresh_at = case
                when failures = 0 and (claimed_until is null or claimed_until <= ${now})
                    then least(next_refresh_at, ${now})
                else next_refresh_at
            end
        where org_id = ${orgId} and lower(repo) = lower(${hint.repo})
          and (pr_number = any(${numbers}::int[]) or (${sha}::text is not null and head_sha = ${sha}))
        returning task_key
    `;
    return rows.length;
}

interface ObservationRow {
    task_key: string;
    repo: string;
    pr_number: number;
    attempt: number;
    revision: string;
    fingerprint: string | null;
    outcome: string | null;
    repairable: boolean;
    pr_state: string | null;
    pr_url: string | null;
    base_branch: string | null;
    head_sha: string | null;
    target_sha: string | null;
    mergeability: string | null;
    checks: string | null;
    review: string | null;
    evidence: CheckEvidence[];
    stale: boolean;
    error_code: string | null;
    error_detail: string | null;
    observed_at: Date | null;
    next_refresh_at: Date;
}

export async function readObservations(deps: ObservationDeps, batchId: string): Promise<BatchPrObservation[]> {
    const { sql, orgId } = deps;
    const rows = await sql<ObservationRow[]>`
        select o.task_key, o.repo, o.pr_number, o.attempt, o.revision::text as revision, o.fingerprint, o.outcome,
               o.repairable, o.pr_state, o.pr_url, o.base_branch, o.head_sha, o.target_sha, o.mergeability,
               o.checks, o.review, o.evidence, o.stale, o.error_code, o.error_detail, o.observed_at,
               o.next_refresh_at
        from batch_pr_observation o
        join batch_task t on t.org_id = o.org_id and t.batch_id = o.batch_id and t.key = o.task_key
        join batch_stage s on s.org_id = t.org_id and s.batch_id = t.batch_id and s.key = t.stage_key
        where o.org_id = ${orgId} and o.batch_id = ${batchId}
        order by s.position, t.position
    `;
    return rows.map((row) => ({
        taskKey: row.task_key,
        repo: row.repo,
        prNumber: row.pr_number,
        attempt: row.attempt,
        revision: Number(row.revision),
        fingerprint: row.fingerprint,
        outcome: row.outcome,
        repairable: row.repairable,
        prState: row.pr_state,
        prUrl: row.pr_url,
        baseBranch: row.base_branch,
        headSha: row.head_sha,
        targetSha: row.target_sha,
        mergeability: row.mergeability,
        checks: row.checks,
        review: row.review,
        evidence: row.evidence,
        stale: row.stale,
        error: row.error_code === null ? null : { code: row.error_code, detail: row.error_detail },
        observedAt: row.observed_at?.toISOString() ?? null,
        nextRefreshAt: row.next_refresh_at.toISOString(),
    }));
}
