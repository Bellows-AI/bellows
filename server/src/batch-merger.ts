import {
    judgeFreshFacts,
    judgeStageVerification,
    changeRequestIs,
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
    VERIFY_UNKNOWN,
    type PrFacts,
    type RepoRef,
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
    type MergeCandidate,
    type MergeDeps,
    type MergeIntent,
    type MergeOutcome,
    type VerificationJob,
} from './db/batches/batch-store-merge.js';
import { GitHubMergeError, type MergeResult } from './github/pr-merge.js';
import type { MergeTokenSource } from './forge/pr-token.js';
import {
    INSTALLATION_CREDENTIAL,
    resolveForgeClient,
    type ForgeClient,
    type ForgeSource,
} from './forge/forge-client.js';
import { readClient, tokenClient, type GitlabReads, type ReadDeps, type Unread } from './forge/forge-reads.js';
import { isGitlabRepo } from './forge/forges.js';
import { MERGE_REQUEST_DEADLINE_MS } from './forge/gitlab-merge.js';
import { FORGE_READ_DEADLINE_MS } from './forge/gitlab-reads.js';
import { logger } from './log.js';

/**
 * The batch merger (docs/batches.md): merges the PRs of automerge stages the observer found ready,
 * and verifies each merged stage as a whole. It never decides what GitHub requires — it asks, bound
 * to the head it observed — and it never repeats a request whose answer it does not know: that
 * intent is reconciled against the PR first. Each task is read and merged as its batch's starter on GitLab (the
 * member's grant), and a grant the board cannot confirm leaves the merge for a later pass, never a verdict. Every decision is a durable row written before the
 * provider is called, so a restart, a second replica or a timeout cannot merge twice or lose a merge.
 */

/** Intents dispatched at once; the repository/target slot already keeps one target to one request. */
export const MERGE_CONCURRENCY = 4;
/** Stages verified per pass, so a backlog cannot starve the next tick. */
const VERIFY_BATCH = 10;
/** `pr_merge.delivery_id` is bounded to 64 characters (048). */
const DELIVERY_ID_LIMIT = 64;
/** Token read and refresh for one batch's starter; the merge request has its own timeout after it. */
export const MERGE_TOKEN_DEADLINE_MS = 15_000;

export interface BatchMergerDeps {
    sql: Sql;
    orgId: string;
    ready?: Promise<unknown> | undefined;
    /** What the org's PRs are read and merged through; absent offline: nothing is merged or verified. */
    forge?: ForgeSource | undefined;
    /** What GitLab is read and merged through, as the starter; absent on a board with no GitLab access. */
    gitlab?: GitlabReads | undefined;
    /** Records a merge in the ledger: the job store's `closeMergedPr`. */
    recordMerge: (repo: RepoRef, prNumber: number, deliveryId: string, mergedAt: Date | undefined) => Promise<unknown>;
    /** Lets the gate judge the merge just recorded and the scheduler advance a verified stage. */
    reconcile: (batchId: string) => Promise<unknown>;
    /** The token a merge is sent with: the batch starter's (docs/batches.md). GitHub reads stay on the installation. */
    mergeToken: MergeTokenSource;
    now?: (() => Date) | undefined;
    concurrency?: number | undefined;
}

export interface BatchMerger {
    /** One pass: reconcile unresolved requests, merge what is ready, verify merged stages. Resolves to the work done. */
    mergeDue(): Promise<number>;
}

interface Run {
    store: MergeDeps;
    reads: ReadDeps;
    recordMerge: BatchMergerDeps['recordMerge'];
    reconcile: BatchMergerDeps['reconcile'];
    clock: () => Date;
    /** The starter's token per claimed batch, resolved before its intent was claimed and held only for this pass. */
    tokens: Map<string, string>;
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

/**
 * A GitHub answer that does not belong to the identity it was asked for: another forge or host (the reader answers for
 * github.com only), another repository or another pull request. Inconclusive: nothing is applied or advanced on it.
 */
class UnboundRead extends Error {}

/** The board holds no grant, connection or starter to read as: no request was made, and nothing is concluded. */
class UnconfirmedRead extends Error {}

const unreadOf = (unread: Unread): Error =>
    unread.kind === 'binding' ? new UnboundRead(unread.detail) : new UnconfirmedRead(unread.detail);

/** The client for `repo` read as the batch's `starter`; one no client answers for is unbound, an unread grant unconfirmed. */
async function clientFor(run: Run, repo: RepoRef, starter: string | null, signal: AbortSignal): Promise<ForgeClient> {
    const resolved = await readClient(run.reads, repo, starter, signal);
    if (!resolved.ok) throw unreadOf(resolved);
    return resolved.client;
}

/** A change request and the starter whose grant reads it. */
interface Subject {
    repo: RepoRef;
    prNumber: number;
    startedBy: string | null;
}

/** The one place a change request is read: the answer is returned only when it is for this repository and number. */
async function readBound({ repo, prNumber, startedBy }: Subject, run: Run, signal: AbortSignal): Promise<PrFacts> {
    const facts = await (await clientFor(run, repo, startedBy, signal)).readChangeRequest(prNumber);
    if (!changeRequestIs(facts, repo, prNumber)) throw new UnboundRead('the forge answered for another change request');
    return facts;
}

/** One read deadline per unit of work: it covers the token read, the connection read and every request. */
const readSignal = (): AbortSignal => AbortSignal.timeout(FORGE_READ_DEADLINE_MS);

/** A fresh read of the PR, or the outcome that records why none was possible: nothing was requested. */
async function readFresh(run: Run, intent: MergeIntent): Promise<{ facts: PrFacts } | { unread: MergeOutcome }> {
    try {
        return { facts: await readBound(intent, run, readSignal()) };
    } catch (e) {
        if (e instanceof UnboundRead) return { unread: { state: MERGE_CHANGED, detail: e.message } };
        const retryAfterMs = (e as { retryAfterMs?: number | null }).retryAfterMs ?? null;
        const detail = `the change request could not be read: ${errorMessage(e)}`;
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
    const fresh = judgeFreshFacts(intent, read);
    if (!fresh.proceed) {
        if (fresh.kind === 'merged') return merged(run, intent, mergedFactsOf(read));
        return settled(run, intent, { state: MERGE_CHANGED, detail: fresh.reason });
    }
    if (await batchFenced(run.store, intent.batchId)) return void (await resolveMerge(run.store, intent, FENCED));
    // The lease covers the request itself: if another pass already reconciled this intent as expired, nothing is sent.
    if (!(await renewLease(run.store, intent))) return;
    const token = run.tokens.get(intent.batchId);
    if (token === undefined) {
        return settled(run, intent, { state: MERGE_LAPSED, detail: 'no merge token was resolved', retryAfterMs: null });
    }
    // The request has its own deadline, under the lease; a connection that cannot be read means nothing was sent.
    const acting = await tokenClient(run.reads, intent.repo, token, AbortSignal.timeout(MERGE_REQUEST_DEADLINE_MS));
    if (!acting.ok) return settled(run, intent, { state: MERGE_LAPSED, detail: acting.detail, retryAfterMs: null });
    let result: MergeResult;
    try {
        result = await acting.client.mergeChangeRequest(intent.prNumber, { sha: fresh.headSha, method: MERGE_METHOD });
    } catch (e) {
        return settled(run, intent, outcomeOfMergeError(e));
    }
    return merged(run, intent, { mergeCommitSha: result.mergeCommitSha, mergedAt: undefined });
}

/** Whether the board holds a source for the repo's forge: GitHub's installation, or GitLab's grants and connections. */
const answersFor = (run: Run, repo: RepoRef): boolean =>
    isGitlabRepo(repo)
        ? run.reads.gitlab !== undefined
        : resolveForgeClient(run.reads.forge, repo, INSTALLATION_CREDENTIAL).ok;

/**
 * Resolves the starter's token before an intent exists (once per batch per pass): a starter whose grant is not
 * live, a deleted starter or an unreadable token claims nothing, so no attempt is spent and nothing parks the task.
 */
async function admitMerge(run: Run, deps: BatchMergerDeps, candidate: MergeCandidate): Promise<boolean> {
    if (run.tokens.has(candidate.batchId)) return true;
    // A forge no source answers for reads no credential: the dispatch records it as unbound, with no request made.
    if (!answersFor(run, candidate.repo)) return true;
    const token = await deps.mergeToken(
        { orgId: deps.orgId, repo: candidate.repo, startedBy: candidate.startedBy },
        AbortSignal.timeout(MERGE_TOKEN_DEADLINE_MS)
    );
    if (!token.ok) {
        logger('batches').info({ batchId: candidate.batchId, detail: token.detail }, 'a merge waits for its token');
        return false;
    }
    run.tokens.set(candidate.batchId, token.token);
    return true;
}

/** A request whose answer is unknown is read back from the PR, never sent again. */
async function reconcileOne(run: Run, intent: MergeIntent): Promise<void> {
    let facts: PrFacts;
    try {
        facts = await readBound(intent, run, readSignal());
    } catch (e) {
        // An answer for another identity, or none for want of a grant, says nothing about this request: it stays unresolved.
        if (e instanceof UnboundRead || e instanceof UnconfirmedRead)
            return void logger('batches').warn(
                { intentId: intent.id, detail: e.message },
                'a merge request cannot be reconciled'
            );
        throw e;
    }
    if (reconcileUncertainMerge(facts) === MERGE_MERGED) return merged(run, intent, mergedFactsOf(facts));
    return settled(run, intent, {
        state: MERGE_LAPSED,
        detail: 'a request of unknown outcome did not merge',
        retryAfterMs: null,
    });
}

async function mergeCommitOf(
    run: Run,
    job: VerificationJob,
    merge: VerificationJob['merges'][number],
    signal: AbortSignal
): Promise<string | null> {
    const facts = await readBound({ ...merge, startedBy: job.startedBy }, run, signal);
    return facts.merged ? facts.mergeCommitSha : null;
}

/** What the stage's merges and the target say, or an `unknown` that waits: an unreadable target is never a pass. */
async function judgeStage(run: Run, job: VerificationJob): Promise<StageVerification> {
    try {
        // Stored merge commits are judged against the target's branch, so every identity must be one the reader answers for.
        const signal = readSignal();
        const target = await clientFor(run, job.repo, job.startedBy, signal);
        for (const merge of job.merges) await clientFor(run, merge.repo, job.startedBy, signal);
        const merges = await Promise.all(
            job.merges.map(async (merge) => ({
                task: merge.task,
                sha: merge.mergeCommitSha ?? (await mergeCommitOf(run, job, merge, signal)),
            }))
        );
        const shas = merges.flatMap((merge) => (merge.sha === null ? [] : [merge.sha]));
        const state = await target.readBranchState(job.branch, shas);
        return judgeStageVerification({ merges, target: { branch: job.branch, ...state } });
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
const guarded = (what: string, fields: Record<string, unknown>, work: () => Promise<void>): Promise<void> =>
    work().catch((e: unknown) => {
        logger('batches').error({ ...fields, err: e }, `${what} failed`);
    });

export function createBatchMerger(deps: BatchMergerDeps): BatchMerger {
    const { sql, orgId, ready, forge, gitlab, now } = deps;
    const concurrency = deps.concurrency ?? MERGE_CONCURRENCY;
    const store: MergeDeps = { sql, orgId, now };

    return {
        async mergeDue() {
            if (ready) await ready;
            if (!forge && !gitlab) return 0;
            const run: Run = {
                store,
                reads: { forge, gitlab, orgId },
                recordMerge: deps.recordMerge,
                reconcile: deps.reconcile,
                clock: () => (now ? now() : new Date()),
                tokens: new Map(),
            };
            const unresolved = await unresolvedMerges(store, concurrency);
            await Promise.all(
                unresolved.map((intent) =>
                    guarded('reconciling a merge', { batchId: intent.batchId, taskKey: intent.taskKey }, () =>
                        reconcileOne(run, intent)
                    )
                )
            );
            const intents = await claimMerges(store, concurrency, (candidate) => admitMerge(run, deps, candidate));
            await Promise.all(
                intents.map((intent) =>
                    guarded('merging', { batchId: intent.batchId, taskKey: intent.taskKey }, () =>
                        dispatch(run, intent)
                    )
                )
            );
            const jobs = await dueVerifications(store, VERIFY_BATCH);
            for (const job of jobs) {
                await guarded('verifying a stage', { batchId: job.batchId, stageKey: job.stageKey }, () =>
                    verify(run, job)
                );
            }
            return unresolved.length + intents.length + jobs.length;
        },
    };
}
