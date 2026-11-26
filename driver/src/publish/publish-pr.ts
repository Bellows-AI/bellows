import { randomUUID } from 'node:crypto';
import type { BoardJob } from '../board/board.js';
import type { PrOperationKind, PrOperationWrite } from '../board/board-pr-operations.js';
import type { PullRequestAnswer, PullRequestAsk } from '../board/board-pull-request.js';
import { baseBranchOf, isBranchName, parsePrSummary, prSummaryScript } from './publish-base.js';
import type { GitState, PublishPlan, PublishResult, RunPublishStep } from './publish.js';
import { pushWithLease } from './publish-stale.js';
import {
    headSha,
    publicationOp,
    readOperation,
    reconciled,
    recordOperation,
    remoteHeadOf,
} from './publish-reconcile.js';

/**
 * The publish workflow's pull-request half and its push, split from `publish.ts` (which keeps the
 * workflow itself): ask the board to reuse or open the branch's PR as the member who started the task, and the push
 * with the publication ledger and the remote read that keep a retried publish from repeating an effect that landed.
 * The PR is the board's to write (`POST /api/jobs/:id/pull-request`): the runner and the driver never hold the
 * member's token, and a create whose answer was lost is found by head on the board before anything is repeated.
 */

/**
 * Where each managed PR operation is handed as it happens: the loop's recorder writes it
 * to the board under the attempt's lease. It is best effort by contract — it logs its own failure and
 * a publish never depends on it.
 */
export type PrOperationRecorder = (note: PrOperationWrite) => Promise<void>;

/** The board's PR write for this attempt: it answers, or throws when it could not (never a verdict on no answer). */
export type PullRequestPort = (ask: PullRequestAsk) => Promise<PullRequestAnswer>;

/** The board holds the thread: the starter's forge grant cannot serve, so the attempt hands itself back instead of failing. */
export class PullRequestWaiting extends Error {
    constructor(
        readonly forge: string,
        readonly reason: string,
        readonly branch: string
    ) {
        super(`the pull request waits for a ${forge} connection (${reason})`);
        this.name = 'PullRequestWaiting';
    }
}

/** What a failed publish step says when the board did not answer: transport, so the retry reaches the reconcile. */
export const BOARD_UNANSWERED = 'pull request: the board did not answer';
/** Worded so `publishCauseOf` reads `denied` and `publishRetryable` never retries it. */
const BOARD_DENIED = 'Permission to open a pull request denied: GitHub refused the member who started this task';
const BOARD_LEASE = 'pull request: the attempt no longer holds its lease';

/** A PR the board confirmed. */
interface LandedPr {
    url: string;
    number: number;
}

/**
 * One ask of the board and what it means for the publish: the PR it names, null for none (a view that found
 * nothing, or a board with no GitHub App: the push landed and there is no PR to write), or a throw for a wait, a refusal
 * and no answer. A throw of the port is no answer about the PR.
 */
async function askBoard(
    pullRequests: PullRequestPort,
    ask: PullRequestAsk
): Promise<{ pr: LandedPr; operation: 'created' | 'reused' } | null> {
    let answer: PullRequestAnswer;
    try {
        answer = await pullRequests(ask);
    } catch {
        throw new Error(BOARD_UNANSWERED);
    }
    switch (answer.kind) {
        case 'pr':
            return { pr: { url: answer.url, number: answer.number }, operation: answer.operation };
        case 'none':
        case 'no-forge':
            return null;
        case 'waiting':
            throw new PullRequestWaiting(answer.forge, answer.reason, ask.branch);
        case 'denied':
            throw new Error(BOARD_DENIED);
        case 'refused':
            throw new Error(`pull request: GitHub declined it: ${answer.detail}`);
        default:
            throw new Error(BOARD_LEASE);
    }
}

/**
 * Hands one operation to the recorder, with an id minted for it, and answers that id for the publish
 * reply. Nothing is minted without a recorder or a PR the board confirmed (or with no repo label). A recorder
 * that throws anyway leaves the operation unrecorded: the PR is already open, and the publish must neither fail nor
 * open another.
 */
async function notePrOperation(
    record: PrOperationRecorder | undefined,
    note: { job: BoardJob; branch: string; operation: PrOperationKind; pr: LandedPr | null }
): Promise<string | undefined> {
    const { job, branch, operation, pr } = note;
    if (!record || !pr || !job.repo) return undefined;
    const operationId = randomUUID();
    await record({ operationId, operation, repo: job.repo.path, prNumber: pr.number, prUrl: pr.url, branch }).catch(
        () => undefined
    );
    return operationId;
}

/**
 * A clean, fully-pushed checkout on its task branch may still carry a PR the agent opened itself:
 * the publication record names it, so the board links the one PR and a retry or a
 * resume reuses it instead of opening a second. The board retargets a reused PR onto the claim's base
 * branch (the agent may have opened it with the default): the board must never record, or automerge, a PR into a
 * branch the task does not target.
 */
export async function reconcileAgentPr(context: {
    job: BoardJob;
    state: GitState;
    pullRequests: PullRequestPort;
    record?: PrOperationRecorder | undefined;
}): Promise<PublishResult | null> {
    const { job, state, pullRequests, record } = context;
    const { branch } = state;
    if (!branch || branch === state.defaultBranch || !isBranchName(branch)) return null;
    const found = await askBoard(pullRequests, { branch, base: baseBranchOf(job) });
    if (!found) return null;
    const operationId = await notePrOperation(record, { job, branch, operation: 'reused', pr: found.pr });
    return publishedResult(job, branch, state.defaultBranch, {
        prUrl: found.pr.url,
        prNumber: found.pr.number,
        ...(operationId ? { operationId } : {}),
    });
}

/** What the PR says of the work: the branch's own summary, decoration over the plan's title. */
async function describePr(
    runStep: RunPublishStep,
    context: { plan: PublishPlan; state: GitState; draft: boolean }
): Promise<{ title: string; body: string }> {
    const { plan, state, draft } = context;
    // The PR speaks for the work, not for the command that started it: a
    // summarizer script reads the branch — its commits and the diff against the default
    // — in the same throwaway-container shape as every other step. It needs no
    // credential (local git reads only) and its failure is decoration: the
    // command-derived plan title and the plain body stay the fallback. BACKSTOP_TITLE names
    // this publish's own just-created commit (its subject IS plan.title) so the script never
    // selects the command text as the title — the commit's work stays in the
    // diff and its subject in the body, but it cannot win the title.
    const summarized = await runStep({
        label: 'pr summary',
        entrypoint: 'node',
        args: ['-e', prSummaryScript],
        env: false,
        envLiterals: { BASE: `origin/${state.defaultBranch}`, BACKSTOP_TITLE: plan.title },
        inRepo: true,
    })
        .then((r) => parsePrSummary(r.stdout))
        .catch(() => null);
    let title = summarized?.title ?? plan.title;
    // The ref is appended only when the branch's own title does not already END with it
    // — the driver's own backstop commit and the repo's commit convention both close
    // with `(#N)`, and a subject that merely MENTIONS the issue must not suppress it.
    if (summarized?.title && plan.issueNumber && !summarized.title.endsWith(`(#${plan.issueNumber})`)) {
        title = `${summarized.title} (#${plan.issueNumber})`;
    }
    const body = [
        summarized?.body,
        plan.issueNumber ? `Closes #${plan.issueNumber}.` : null,
        draft
            ? 'Draft published by the agent while the task runs; the gates may not have passed yet.'
            : 'Published by the factory board after the declared gates passed.',
    ]
        .filter(Boolean)
        .join('\n\n');
    return { title, body };
}

/**
 * Reuses the branch's PR when one exists — a task that already shipped its PR gets idempotent
 * publishes, not duplicates, and its title and body are rewritten to say what the branch holds now — or opens one
 * summarized from the branch's own commits and diff. One ask: the board views by head before it creates, so an
 * ask repeated after a lost answer finds the PR it opened.
 */
export async function resolveOrCreatePr(
    runStep: RunPublishStep,
    context: {
        job: BoardJob;
        branch: string;
        plan: PublishPlan;
        state: GitState;
        draft: boolean;
        pullRequests: PullRequestPort;
        record?: PrOperationRecorder | undefined;
    }
): Promise<{ prUrl: string | null; prNumber: number | null; operationId?: string }> {
    const { job, branch, plan, state, draft, pullRequests, record } = context;
    const { title, body } = await describePr(runStep, { plan, state, draft });
    const landed = await askBoard(pullRequests, {
        branch,
        base: baseBranchOf(job),
        create: { title, body, draft, base: state.defaultBranch },
        edit: { title, body },
    });
    const operationId = await notePrOperation(record, {
        job,
        branch,
        operation: landed?.operation ?? 'reused',
        pr: landed?.pr ?? null,
    });
    return {
        prUrl: landed?.pr.url ?? null,
        prNumber: landed?.pr.number ?? null,
        ...(operationId ? { operationId } : {}),
    };
}

/**
 * Lands the branch's commit on the remote and records how far it got. The push is asked about
 * before it is repeated: one that failed may still have landed, and the remote's own head — not the
 * answer — decides. `pushing` is recorded before the effect, `pushed` after it. Every remote call runs the
 * job's own `credentialHelper` (`credentialHelperOf`): the push, its stale-lease fetch and the remote-head read.
 */
export async function pushRecorded(
    runStep: RunPublishStep,
    step: RunPublishStep,
    publication: { repo: string; branch: string; op: string; sha: string; credentialHelper: string }
): Promise<void> {
    const { repo, branch, op, sha, credentialHelper } = publication;
    await recordOperation(step, repo, op, { state: 'pushing' });
    await reconciled(
        () =>
            pushWithLease(
                step,
                {
                    label: 'git push',
                    entrypoint: 'git',
                    args: [
                        '-c',
                        `credential.helper=${credentialHelper}`,
                        'push',
                        '-u',
                        '--force-with-lease',
                        'origin',
                        'HEAD',
                    ],
                    env: true,
                    inRepo: true,
                    op,
                },
                { branch, credentialHelper, sha }
            ),
        async () => ((await remoteHeadOf(runStep, branch, credentialHelper)) === sha ? undefined : null)
    );
    await recordOperation(step, repo, op, { state: 'pushed' });
}

/** The published result of a branch whose pull request is `prUrl`. */
export const publishedResult = (
    job: BoardJob,
    branch: string,
    base: string | undefined,
    landed: { prUrl: string | null; prNumber: number | null; operationId?: string }
): PublishResult => ({
    ok: true,
    published: true,
    branch,
    prUrl: landed.prUrl,
    reason: null,
    repository: job.repo?.path ?? null,
    baseBranch: base ?? null,
    prNumber: landed.prNumber,
    cause: null,
    ...(landed.operationId ? { operationId: landed.operationId } : {}),
});

/**
 * A clean, fully-pushed tree whose own earlier publication stopped between the push and the pull
 * request (the ledger says `pushing` or `pushed`, and no PR exists): the push is not repeated, the
 * PR is opened.
 * Null when the ledger holds no such operation — then there is nothing of ours to resume.
 */
export async function resumePublication(
    runStep: RunPublishStep,
    step: RunPublishStep,
    context: {
        job: BoardJob;
        repo: string;
        state: GitState;
        plan: PublishPlan;
        draft: boolean;
        pullRequests: PullRequestPort;
        record?: PrOperationRecorder | undefined;
    }
): Promise<PublishResult | null> {
    const { job, repo, state, plan, draft, pullRequests, record } = context;
    const { branch } = state;
    if (!branch || branch === state.defaultBranch || !isBranchName(branch)) return null;
    const sha = await headSha(runStep);
    if (sha === null) return null;
    const op = publicationOp(branch, sha);
    // `pushing` counts too: the tree is clean and has nothing unpushed, so git itself says the push
    // landed — only its answer, and the ledger entry after it, were lost.
    const { state: reached } = await readOperation(runStep, repo, op);
    if (reached !== 'pushing' && reached !== 'pushed') return null;
    const landed = await resolveOrCreatePr(runStep, { job, branch, plan, state, draft, pullRequests, record });
    await recordOperation(step, repo, op, { state: 'opened', ...(landed.prUrl ? { prUrl: landed.prUrl } : {}) });
    return publishedResult(job, branch, state.defaultBranch, landed);
}
