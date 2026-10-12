import {
    ATTENTION_REFUSED,
    GATE_OPEN,
    GATE_PASSED,
    judgeMergeCandidate,
    MERGE_DISPATCHING,
    MERGE_CHANGED,
    MERGE_LAPSED,
    MERGE_LEASE_MS,
    MERGE_MAX_LAPSES,
    MERGE_MERGED,
    MERGE_METHOD,
    MERGE_REFUSED,
    MERGE_SLOT_STATES,
    MERGE_UNCERTAIN,
    mergeRetryDelayMs,
    OBSERVE_INTERVAL_MS,
    OUTCOME_READY,
    AUTOMERGE,
    BATCH_COMPLETION_PR,
    TASK_SUCCEEDED,
    VERIFY_PASSED,
    type MergeState,
    type StageVerification,
} from '@factory-ai/core';
import type { Sql, TransactionSql } from 'postgres';
import { ACCEPTANCE_PR_MERGED, BATCH_STARTED, DECISION_ADVANCE } from './batch-store-types.js';

/**
 * Merge intents and stage verification (064; docs/batches.md). Phase one runs under the batch row's
 * lock and records the intent before anything is asked of GitHub; the provider is called with no
 * lock held; phase two records what came back. The two unique indexes on `batch_merge` are the
 * fences: one intent per observation, and one unresolved request per repository and target branch
 * across every batch.
 */

export interface MergeDeps {
    sql: Sql;
    orgId: string;
    now?: (() => Date) | undefined;
}

const nowOf = (deps: MergeDeps): Date => (deps.now ? deps.now() : new Date());

/** Outcomes that sent nothing the provider accepted: the same task may be tried again after a backoff, a bounded number of times. */
const RETRYABLE: string[] = [MERGE_LAPSED, MERGE_CHANGED];

/** Candidates listed per intent wanted: some are skipped under the lock (a competing batch holds the slot). */
const LISTING_FACTOR = 4;
/** An outcome's or verification's detail is stored for a person to read, bounded. */
const DETAIL_LIMIT = 500;

/** A recorded decision to merge one PR, bound to what was observed. */
export interface MergeIntent {
    id: string;
    batchId: string;
    taskKey: string;
    attempt: number;
    repo: string;
    prNumber: number;
    targetBranch: string;
    headSha: string;
}

interface CandidateRow {
    batch_id: string;
    task_key: string;
    attempt: number;
    policy: string;
    completion_kind: string;
    execution: string;
    gate: string;
    target_branch: string;
    o_attempt: number;
    outcome: string | null;
    stale: boolean;
    error_code: string | null;
    base_branch: string | null;
    head_sha: string | null;
    target_sha: string | null;
    revision: number;
    pr_repo: string;
    pr_number: number;
}

/**
 * Tasks of automerge stages whose observed PR may be ready, oldest batch first: succeeded, gate
 * open, in a live batch, not yet merged, with no intent for this observation, no request left
 * unresolved on their repository/target, and no recent lapse still backing off.
 */
function candidateRows(
    db: Sql | TransactionSql,
    run: { orgId: string; now: Date; limit: number; only?: { batchId: string; taskKey: string } }
) {
    const { orgId, now, limit, only } = run;
    const scope = only ? db`and t.batch_id = ${only.batchId} and t.key = ${only.taskKey}` : db``;
    return db<CandidateRow[]>`
        select t.batch_id, t.key as task_key, a.attempt, s.policy, t.completion_kind, t.execution, t.gate,
               tg.branch as target_branch, o.attempt as o_attempt, o.outcome, o.stale, o.error_code, o.base_branch,
               o.head_sha, o.target_sha, o.revision::int as revision, o.repo as pr_repo, o.pr_number
        from batch_task t
        join batch b on b.org_id = t.org_id and b.id = t.batch_id
        join batch_stage s on s.org_id = t.org_id and s.batch_id = t.batch_id and s.key = t.stage_key
        join batch_target tg on tg.org_id = t.org_id and tg.batch_id = t.batch_id and tg.key = t.target_key
        join lateral (
            select max(attempt)::int as attempt from batch_attempt
            where org_id = t.org_id and batch_id = t.batch_id and task_key = t.key
        ) a on a.attempt is not null
        join batch_pr_observation o on o.org_id = t.org_id and o.batch_id = t.batch_id and o.task_key = t.key
        where t.org_id = ${orgId} and b.status = ${BATCH_STARTED}
          and b.cancelled_at is null and b.expired_at is null and b.completed_at is null
          and s.policy = ${AUTOMERGE} and t.completion_kind = ${BATCH_COMPLETION_PR}
          and t.execution = ${TASK_SUCCEEDED} and t.gate = ${GATE_OPEN}
          -- Only rows judgeMergeCandidate can accept count against the limit, so a backlog of
          -- unready PRs in an older batch cannot hide a ready one in a newer batch.
          and o.outcome = ${OUTCOME_READY} and not o.stale and o.error_code is null
          and o.attempt = a.attempt and o.base_branch = tg.branch and o.head_sha is not null
          ${scope}
          and not exists (
              select 1 from batch_decision d
              where d.org_id = t.org_id and d.batch_id = t.batch_id and d.key = ${`${DECISION_ADVANCE}:`}::text || t.stage_key
          )
          and not exists (
              select 1 from pr_merge m where m.org_id = o.org_id and m.repo = o.repo and m.pr_number = o.pr_number
          )
          and not exists (
              select 1 from batch_merge m
              where m.org_id = t.org_id and m.batch_id = t.batch_id and m.task_key = t.key and m.attempt = a.attempt
                and ((m.observation_revision = o.revision and m.state not in ${db(RETRYABLE)})
                     or (m.state in ${db(RETRYABLE)} and m.retry_at > ${now}))
          )
          and (select count(*) from batch_merge m
               where m.org_id = t.org_id and m.batch_id = t.batch_id and m.task_key = t.key and m.attempt = a.attempt
                 and m.state in ${db(RETRYABLE)}) < ${MERGE_MAX_LAPSES}
          and not exists (
              select 1 from batch_merge m
              where m.org_id = t.org_id and lower(m.repo) = lower(o.repo) and m.target_branch = tg.branch
                and m.state in ${db(MERGE_SLOT_STATES)}
          )
        order by b.started_at, b.id, s.position, t.position
        limit ${limit}
    `;
}

const candidateOf = (row: CandidateRow) =>
    judgeMergeCandidate({
        policy: row.policy,
        completionKind: row.completion_kind,
        execution: row.execution,
        gate: row.gate,
        fenced: false,
        attempt: row.attempt,
        targetBranch: row.target_branch,
        observation: {
            attempt: row.o_attempt,
            outcome: row.outcome,
            stale: row.stale,
            error: row.error_code,
            baseBranch: row.base_branch,
            headSha: row.head_sha,
        },
    });

/**
 * Records merge intents for ready tasks, one transaction each under the batch's lock, and returns
 * them for dispatch. The fence is re-read under the lock, so a cancel or expiry that committed first
 * stops the request before it exists; a competing batch holding the target's slot, or a duplicate
 * claim, conflicts on an index and is skipped.
 */
export async function claimMerges(deps: MergeDeps, limit: number): Promise<MergeIntent[]> {
    const { sql, orgId } = deps;
    const now = nowOf(deps);
    const listed = await candidateRows(sql, { orgId, now, limit: limit * LISTING_FACTOR });
    const intents: MergeIntent[] = [];
    for (const row of listed) {
        if (intents.length >= limit) break;
        if (!candidateOf(row).merge) continue;
        const intent = await sql.begin(async (tx) => {
            const [batch] = await tx<{ id: string }[]>`
                select id from batch
                where org_id = ${orgId} and id = ${row.batch_id} and status = ${BATCH_STARTED}
                  and cancelled_at is null and expired_at is null and completed_at is null
                for update
            `;
            if (!batch) return null;
            // Under the lock the row is read again: what was listed may have moved since.
            const [fresh] = await candidateRows(tx, {
                orgId,
                now,
                limit: 1,
                only: { batchId: row.batch_id, taskKey: row.task_key },
            });
            if (!fresh || !candidateOf(fresh).merge) return null;
            const [inserted] = await tx<{ id: string }[]>`
                insert into batch_merge (org_id, batch_id, task_key, attempt, observation_revision, repo, pr_number,
                                         target_branch, head_sha, target_sha, method, state, lease_until)
                values (${orgId}, ${fresh.batch_id}, ${fresh.task_key}, ${fresh.attempt}, ${fresh.revision},
                        ${fresh.pr_repo}, ${fresh.pr_number}, ${fresh.target_branch}, ${fresh.head_sha!},
                        ${fresh.target_sha}, ${MERGE_METHOD}, ${MERGE_DISPATCHING},
                        ${new Date(now.getTime() + MERGE_LEASE_MS)})
                on conflict do nothing
                returning id::text as id
            `;
            if (!inserted) return null;
            await tx`
                update batch_task set attention = null
                where org_id = ${orgId} and batch_id = ${fresh.batch_id} and key = ${fresh.task_key}
                  and attention = ${ATTENTION_REFUSED}
            `;
            return {
                id: inserted.id,
                batchId: fresh.batch_id,
                taskKey: fresh.task_key,
                attempt: fresh.attempt,
                repo: fresh.pr_repo,
                prNumber: fresh.pr_number,
                targetBranch: fresh.target_branch,
                headSha: fresh.head_sha!,
            };
        });
        if (intent) intents.push(intent);
    }
    return intents;
}

/** True when the batch is cancelled, expired or finished: nothing is requested behind a fence. */
export async function batchFenced(deps: MergeDeps, batchId: string): Promise<boolean> {
    const [row] = await deps.sql<{ fenced: boolean }[]>`
        select (status <> ${BATCH_STARTED} or cancelled_at is not null or expired_at is not null
                or completed_at is not null) as fenced
        from batch where org_id = ${deps.orgId} and id = ${batchId}
    `;
    return row?.fenced ?? true;
}

export type MergeOutcome =
    | { state: typeof MERGE_MERGED; mergeCommitSha: string | null }
    | { state: typeof MERGE_UNCERTAIN; detail: string }
    | { state: typeof MERGE_LAPSED; detail: string; retryAfterMs: number | null }
    | { state: Exclude<MergeState, 'merged' | 'uncertain' | 'lapsed' | 'dispatching'>; detail: string };

/** When a retryable outcome may be tried again, and whether its tries are now spent; neither for any other outcome. */
async function retryPlan(
    tx: TransactionSql,
    run: {
        orgId: string;
        row: { batch_id: string; task_key: string; attempt: number };
        outcome: MergeOutcome;
        now: Date;
    }
): Promise<{ retryAt: Date | null; spent: boolean }> {
    const { orgId, row, outcome, now } = run;
    if (!RETRYABLE.includes(outcome.state)) return { retryAt: null, spent: false };
    const [lapses] = await tx<{ n: number }[]>`
        select count(*)::int as n from batch_merge
        where org_id = ${orgId} and batch_id = ${row.batch_id} and task_key = ${row.task_key}
          and attempt = ${row.attempt} and state in ${tx(RETRYABLE)}
    `;
    const tries = lapses!.n + 1;
    const retryAfterMs = 'retryAfterMs' in outcome ? outcome.retryAfterMs : null;
    return {
        retryAt: new Date(now.getTime() + mergeRetryDelayMs(tries, retryAfterMs)),
        spent: tries >= MERGE_MAX_LAPSES,
    };
}

/**
 * Records what became of an intent. Only an unresolved intent changes, so a late or repeated answer
 * writes nothing. A provider refusal parks the task for a person (`attention`), which a later
 * intent or the merged gate clears; every other non-merge outcome waits for a fresh observation.
 */
export async function resolveMerge(
    deps: MergeDeps,
    intent: Pick<MergeIntent, 'id'>,
    outcome: MergeOutcome
): Promise<boolean> {
    const { sql, orgId } = deps;
    const now = nowOf(deps);
    return sql.begin(async (tx) => {
        const [row] = await tx<{ batch_id: string; task_key: string; attempt: number }[]>`
            select batch_id, task_key, attempt from batch_merge
            where org_id = ${orgId} and id = ${intent.id}::bigint and state in ${tx(MERGE_SLOT_STATES)}
            for update
        `;
        if (!row) return false;
        const detail = 'detail' in outcome ? outcome.detail.slice(0, DETAIL_LIMIT) : null;
        if (outcome.state === MERGE_UNCERTAIN) {
            await tx`
                update batch_merge set state = ${MERGE_UNCERTAIN}, detail = ${detail}, lease_until = null
                where org_id = ${orgId} and id = ${intent.id}::bigint
            `;
            return true;
        }
        const { retryAt, spent } = await retryPlan(tx, { orgId, row, outcome, now });
        await tx`
            update batch_merge
            set state = ${outcome.state}, detail = ${detail}, retry_at = ${retryAt}, lease_until = null,
                merge_commit_sha = ${outcome.state === MERGE_MERGED ? outcome.mergeCommitSha : null},
                resolved_at = ${now}
            where org_id = ${orgId} and id = ${intent.id}::bigint
        `;
        // A request GitHub keeps not accepting is parked for a person once its tries are spent.
        if (outcome.state === MERGE_REFUSED || spent) {
            await tx`
                update batch_task set attention = ${ATTENTION_REFUSED}
                where org_id = ${orgId} and batch_id = ${row.batch_id} and key = ${row.task_key}
                  and gate = ${GATE_OPEN}
            `;
        }
        return true;
    });
}

/**
 * Extends a dispatch's lease just before its request is sent. False when the intent is no longer
 * `dispatching` (another pass reconciled it as expired): the request must not be sent then, or the
 * slot would be free while it is in flight.
 */
export async function renewLease(deps: MergeDeps, intent: Pick<MergeIntent, 'id'>): Promise<boolean> {
    const rows = await deps.sql`
        update batch_merge set lease_until = ${new Date(nowOf(deps).getTime() + MERGE_LEASE_MS)}
        where org_id = ${deps.orgId} and id = ${intent.id}::bigint and state = ${MERGE_DISPATCHING}
        returning id
    `;
    return rows.length > 0;
}

/** Intents whose answer is unknown: `uncertain` ones, and `dispatching` ones whose lease ran out (the process died mid-request). */
export async function unresolvedMerges(deps: MergeDeps, limit: number): Promise<MergeIntent[]> {
    const rows = await deps.sql<
        {
            id: string;
            batch_id: string;
            task_key: string;
            attempt: number;
            repo: string;
            pr_number: number;
            target_branch: string;
            head_sha: string;
        }[]
    >`
        select id::text as id, batch_id, task_key, attempt, repo, pr_number, target_branch, head_sha
        from batch_merge
        where org_id = ${deps.orgId}
          and (state = ${MERGE_UNCERTAIN} or (state = ${MERGE_DISPATCHING} and lease_until <= ${nowOf(deps)}))
        order by id limit ${limit}
    `;
    return rows.map((row) => ({
        id: row.id,
        batchId: row.batch_id,
        taskKey: row.task_key,
        attempt: row.attempt,
        repo: row.repo,
        prNumber: row.pr_number,
        targetBranch: row.target_branch,
        headSha: row.head_sha,
    }));
}

/** What a stage's combined verification reads: the tasks it merged and the target they landed on. */
export interface VerificationJob {
    batchId: string;
    stageKey: string;
    repo: string;
    branch: string;
    merges: { task: string; repo: string; prNumber: number; mergeCommitSha: string | null }[];
}

/**
 * Automerge stages whose required tasks are all accepted but whose merged result is not verified
 * yet and is due a look. Fenced and finished batches are never verified: evidence gathered after a
 * cancel or expiry cannot reactivate the stage.
 */
export async function dueVerifications(deps: MergeDeps, limit: number): Promise<VerificationJob[]> {
    const { sql, orgId } = deps;
    const stages = await sql<{ batch_id: string; stage_key: string; repo: string; branch: string }[]>`
        select distinct b.id as batch_id, s.key as stage_key, s.position, tg.repo, tg.branch, b.started_at
        from batch b
        join batch_stage s on s.org_id = b.org_id and s.batch_id = b.id
        join batch_task t on t.org_id = s.org_id and t.batch_id = s.batch_id and t.stage_key = s.key
        join batch_target tg on tg.org_id = t.org_id and tg.batch_id = t.batch_id and tg.key = t.target_key
        left join batch_stage_verification v
            on v.org_id = s.org_id and v.batch_id = s.batch_id and v.stage_key = s.key
        where b.org_id = ${orgId} and b.status = ${BATCH_STARTED}
          and b.cancelled_at is null and b.expired_at is null and b.completed_at is null
          and s.policy = ${AUTOMERGE}
          and (v.stage_key is null or (v.state <> ${VERIFY_PASSED} and v.next_check_at <= ${nowOf(deps)}))
          and not exists (
              select 1 from batch_decision d
              where d.org_id = b.org_id and d.batch_id = b.id and d.key = ${`${DECISION_ADVANCE}:`}::text || s.key
          )
          and not exists (
              select 1 from batch_task r
              where r.org_id = s.org_id and r.batch_id = s.batch_id and r.stage_key = s.key and r.required
                and not (r.execution = ${TASK_SUCCEEDED} and r.gate = ${GATE_PASSED})
          )
        order by b.started_at, b.id, s.position
        limit ${limit}
    `;
    const jobs: VerificationJob[] = [];
    for (const stage of stages) {
        const merges = await sql<{ task: string; repo: string; pr_number: number; merge_commit_sha: string | null }[]>`
            select t.key as task, a.repo, a.pr_number,
                   (select m.merge_commit_sha from batch_merge m
                    where m.org_id = t.org_id and m.batch_id = t.batch_id and m.task_key = t.key
                      and m.attempt = a.attempt and m.state = ${MERGE_MERGED}
                    order by m.id desc limit 1) as merge_commit_sha
            from batch_task t
            join batch_target tg on tg.org_id = t.org_id and tg.batch_id = t.batch_id and tg.key = t.target_key
            join lateral (
                select attempt, repo, pr_number from batch_acceptance
                where org_id = t.org_id and batch_id = t.batch_id and task_key = t.key and kind = ${ACCEPTANCE_PR_MERGED}
                order by attempt desc limit 1
            ) a on true
            where t.org_id = ${orgId} and t.batch_id = ${stage.batch_id} and t.stage_key = ${stage.stage_key}
              and t.execution = ${TASK_SUCCEEDED} and t.gate = ${GATE_PASSED}
              and tg.repo = ${stage.repo} and tg.branch = ${stage.branch}
            order by t.position
        `;
        jobs.push({
            batchId: stage.batch_id,
            stageKey: stage.stage_key,
            repo: stage.repo,
            branch: stage.branch,
            merges: merges.map((row) => ({
                task: row.task,
                repo: row.repo,
                prNumber: row.pr_number,
                mergeCommitSha: row.merge_commit_sha,
            })),
        });
    }
    return jobs;
}

/**
 * Records a stage's verification, under the batch lock and only while the batch is live. A passed
 * row is final; any other is rewritten by the next look. Returns true when the stage is now passed.
 */
export async function recordVerification(
    deps: MergeDeps,
    run: { batchId: string; stageKey: string; verification: StageVerification }
): Promise<boolean> {
    const { sql, orgId } = deps;
    const now = nowOf(deps);
    const { batchId, stageKey, verification } = run;
    return sql.begin(async (tx) => {
        const [batch] = await tx<{ id: string }[]>`
            select id from batch
            where org_id = ${orgId} and id = ${batchId} and status = ${BATCH_STARTED}
              and cancelled_at is null and expired_at is null and completed_at is null
            for update
        `;
        if (!batch) return false;
        await tx`
            insert into batch_stage_verification (org_id, batch_id, stage_key, state, head_sha, detail, checked_at,
                                                  next_check_at)
            values (${orgId}, ${batchId}, ${stageKey}, ${verification.state}, ${verification.headSha},
                    ${verification.detail.slice(0, DETAIL_LIMIT)}, ${now},
                    ${new Date(now.getTime() + OBSERVE_INTERVAL_MS)})
            on conflict (org_id, batch_id, stage_key) do update
            set state = excluded.state, head_sha = excluded.head_sha, detail = excluded.detail,
                checked_at = excluded.checked_at, next_check_at = excluded.next_check_at
            where batch_stage_verification.state <> ${VERIFY_PASSED}
        `;
        return verification.state === VERIFY_PASSED;
    });
}
