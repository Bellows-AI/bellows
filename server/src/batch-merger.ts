import {
    judgeFreshFacts,
    judgeStageVerification,
    MERGE_CHANGED,
    MERGE_ERR_FORBIDDEN,
    MERGE_ERR_NOT_SENT,
    MERGE_ERR_RATE_LIMITED,
    MERGE_ERR_REFUSED,
    MERGE_FENCED,
    MERGE_LAPSED,
    MERGE_MERGED,
    MERGE_METHOD,
    MERGE_REFUSED,
    MERGE_UNCERTAIN,
    reconcileUncertainMerge,
    sameRepo,
    VERIFY_UNKNOWN,
    type PrFacts,
    type StageVerification,
} from '@factory-ai/core';
import type { Sql } from 'postgres';
import {
    batchFenced,
    claimMerges,
    dueVerifications,
    recordVerification,
    renewLease,
    resolveMerge,
    unresolvedMerges,
    type MergeDeps,
    type MergeIntent,
    type MergeOutcome,
    type VerificationJob,
} from './db/batches/batch-store-merge.js';
import { GitHubMergeError, type MergeResult } from './github/pr-merge.js';
import type { BranchState } from './github/pr-read.js';

/**
 * The batch merger (docs/batches.md): merges the PRs of automerge stages the observer found ready,
 * and verifies each merged stage as a whole. It never decides what GitHub requires — it asks, bound
 * to the head it observed — and it never repeats a request whose answer it does not know: that
 * intent is reconciled against the PR first. Every decision is a durable row written before the
 * provider is called, so a restart, a second replica or a timeout cannot merge twice or lose a merge.
 */

/** Intents dispatched at once; the repository/target slot already keeps one target to one request. */
export const MERGE_CONCURRENCY = 4;
/** Stages verified per pass, so a backlog cannot starve the next tick. */
const VERIFY_BATCH = 10;
/** `pr_merge.delivery_id` is bounded to 64 characters (048). */
const DELIVERY_ID_LIMIT = 64;

/** What the merger needs of the GitHub client. */
export interface MergeClient {
    readPullRequest(repo: string, number: number): Promise<PrFacts>;
    mergePullRequest(repo: string, number: number, request: { sha: string; method: string }): Promise<MergeResult>;
    readBranchState(repo: string, branch: string, shas: readonly string[]): Promise<BranchState>;
}

export interface BatchMergerDeps {
    sql: Sql;
    orgId: string;
    ready?: Promise<unknown> | undefined;
    /** Absent offline: nothing is merged or verified. */
    client?: MergeClient | undefined;
    /** Records a merge in the ledger: the job store's `closeMergedPr`. */
    recordMerge: (repo: string, prNumber: number, deliveryId: string, mergedAt: Date | undefined) => Promise<unknown>;
    /** Lets the gate judge the merge just recorded and the scheduler advance a verified stage. */
    reconcile: (batchId: string) => Promise<unknown>;
    now?: (() => Date) | undefined;
    concurrency?: number | undefined;
}

export interface BatchMerger {
    /** One pass: reconcile unresolved requests, merge what is ready, verify merged stages. Resolves to the work done. */
    mergeDue(): Promise<number>;
}

interface Run {
    store: MergeDeps;
    client: MergeClient;
    recordMerge: BatchMergerDeps['recordMerge'];
    reconcile: BatchMergerDeps['reconcile'];
    clock: () => Date;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const FENCED: MergeOutcome = { state: MERGE_FENCED, detail: 'the batch was fenced' };

interface MergedFacts {
    mergeCommitSha: string | null;
    mergedAt: Date | undefined;
}

const mergedFactsOf = (facts: PrFacts): MergedFacts => ({
    mergeCommitSha: facts.mergeCommitSha,
    mergedAt: facts.mergedAt === null ? undefined : new Date(facts.mergedAt),
});

/** The outcome is durable first; recording the merge is idempotent (keyed by repo and number), so a crash between the two is repaired by the observer reading the PR as merged. */
async function merged(run: Run, intent: MergeIntent, facts: MergedFacts): Promise<void> {
    const outcome: MergeOutcome = { state: MERGE_MERGED, mergeCommitSha: facts.mergeCommitSha };
    await resolveMerge(run.store, intent, outcome);
    const id = `board:${facts.mergeCommitSha ?? intent.prNumber}`.slice(0, DELIVERY_ID_LIMIT);
    await run.recordMerge(intent.repo, intent.prNumber, id, facts.mergedAt ?? run.clock());
    await run.reconcile(intent.batchId);
}

async function settled(run: Run, intent: MergeIntent, outcome: MergeOutcome): Promise<void> {
    await resolveMerge(run.store, intent, outcome);
    await run.reconcile(intent.batchId);
}

/** How the provider's failure to merge is recorded: a decline parks, a rate limit or an unsent request waits, anything else is unknown. */
function outcomeOfMergeError(e: unknown): MergeOutcome {
    if (!(e instanceof GitHubMergeError)) return { state: MERGE_UNCERTAIN, detail: errorMessage(e) };
    switch (e.kind) {
        case MERGE_ERR_REFUSED:
        case MERGE_ERR_FORBIDDEN:
            return { state: MERGE_REFUSED, detail: e.message };
        case MERGE_ERR_RATE_LIMITED:
        case MERGE_ERR_NOT_SENT:
            return { state: MERGE_LAPSED, detail: e.message, retryAfterMs: e.retryAfterMs };
        default:
            return { state: MERGE_UNCERTAIN, detail: e.message };
    }
}

/** A fresh read of the PR, or the outcome that records why none was possible: nothing was requested. */
async function readFresh(run: Run, intent: MergeIntent): Promise<{ facts: PrFacts } | { unread: MergeOutcome }> {
    try {
        return { facts: await run.client.readPullRequest(intent.repo, intent.prNumber) };
    } catch (e) {
        const retryAfterMs = (e as { retryAfterMs?: number | null }).retryAfterMs ?? null;
        const detail = `the PR could not be read: ${errorMessage(e)}`;
        return { unread: { state: MERGE_LAPSED, detail, retryAfterMs } };
    }
}

/**
 * One intent, from the recorded decision to the provider's answer. The fence is read again after
 * the intent exists and once more after the fresh read: a cancel or expiry that committed since
 * stops the request, while a request already accepted by the provider is recorded regardless.
 */
async function dispatch(run: Run, intent: MergeIntent): Promise<void> {
    if (await batchFenced(run.store, intent.batchId)) return void (await resolveMerge(run.store, intent, FENCED));
    const fetched = await readFresh(run, intent);
    if ('unread' in fetched) return settled(run, intent, fetched.unread);
    const read = fetched.facts;
    if (!sameRepo(read.repo, intent.repo) || read.number !== intent.prNumber) {
        return settled(run, intent, { state: MERGE_CHANGED, detail: 'GitHub answered for another pull request' });
    }
    const fresh = judgeFreshFacts(intent, read);
    if (!fresh.proceed) {
        if (fresh.kind === 'merged') return merged(run, intent, mergedFactsOf(read));
        return settled(run, intent, { state: MERGE_CHANGED, detail: fresh.reason });
    }
    if (await batchFenced(run.store, intent.batchId)) return void (await resolveMerge(run.store, intent, FENCED));
    // The lease covers the request itself: if another pass already reconciled this intent as expired, nothing is sent.
    if (!(await renewLease(run.store, intent))) return;
    let result: MergeResult;
    try {
        result = await run.client.mergePullRequest(intent.repo, intent.prNumber, {
            sha: fresh.headSha,
            method: MERGE_METHOD,
        });
    } catch (e) {
        return settled(run, intent, outcomeOfMergeError(e));
    }
    return merged(run, intent, { mergeCommitSha: result.mergeCommitSha, mergedAt: undefined });
}

/** A request whose answer is unknown is read back from the PR, never sent again. */
async function reconcileOne(run: Run, intent: MergeIntent): Promise<void> {
    const facts = await run.client.readPullRequest(intent.repo, intent.prNumber);
    if (reconcileUncertainMerge(facts) === MERGE_MERGED) return merged(run, intent, mergedFactsOf(facts));
    return settled(run, intent, {
        state: MERGE_LAPSED,
        detail: 'a request of unknown outcome did not merge',
        retryAfterMs: null,
    });
}

async function mergeCommitOf(run: Run, repo: string, prNumber: number): Promise<string | null> {
    const facts = await run.client.readPullRequest(repo, prNumber);
    return facts.merged && sameRepo(facts.repo, repo) ? facts.mergeCommitSha : null;
}

/** What the stage's merges and the target say, or an `unknown` that waits: an unreadable target is never a pass. */
async function judgeStage(run: Run, job: VerificationJob): Promise<StageVerification> {
    try {
        const merges = await Promise.all(
            job.merges.map(async (merge) => ({
                task: merge.task,
                sha: merge.mergeCommitSha ?? (await mergeCommitOf(run, merge.repo, merge.prNumber)),
            }))
        );
        const shas = merges.flatMap((merge) => (merge.sha === null ? [] : [merge.sha]));
        const target = await run.client.readBranchState(job.repo, job.branch, shas);
        return judgeStageVerification({ merges, target: { branch: job.branch, ...target } });
    } catch (e) {
        return { state: VERIFY_UNKNOWN, detail: `the target could not be read: ${errorMessage(e)}`, headSha: null };
    }
}

async function verify(run: Run, job: VerificationJob): Promise<void> {
    const verification = await judgeStage(run, job);
    if (await recordVerification(run.store, { batchId: job.batchId, stageKey: job.stageKey, verification })) {
        await run.reconcile(job.batchId);
    }
}

/** One failed unit of work is logged and left for the next pass; it never stops the others. */
const guarded = (what: string, work: () => Promise<void>): Promise<void> =>
    work().catch((e: unknown) => {
        console.error(`[batches] ${what} failed: ${errorMessage(e)}`);
    });

export function createBatchMerger(deps: BatchMergerDeps): BatchMerger {
    const { sql, orgId, ready, client, now } = deps;
    const concurrency = deps.concurrency ?? MERGE_CONCURRENCY;
    const store: MergeDeps = { sql, orgId, now };

    return {
        async mergeDue() {
            if (ready) await ready;
            if (!client) return 0;
            const run: Run = {
                store,
                client,
                recordMerge: deps.recordMerge,
                reconcile: deps.reconcile,
                clock: () => (now ? now() : new Date()),
            };
            const unresolved = await unresolvedMerges(store, concurrency);
            await Promise.all(
                unresolved.map((intent) =>
                    guarded(`reconciling merge of ${intent.repo}#${intent.prNumber}`, () => reconcileOne(run, intent))
                )
            );
            const intents = await claimMerges(store, concurrency);
            await Promise.all(
                intents.map((intent) =>
                    guarded(`merging ${intent.repo}#${intent.prNumber}`, () => dispatch(run, intent))
                )
            );
            const jobs = await dueVerifications(store, VERIFY_BATCH);
            for (const job of jobs) {
                await guarded(`verifying stage ${job.stageKey} of ${job.batchId}`, () => verify(run, job));
            }
            return unresolved.length + intents.length + jobs.length;
        },
    };
}
