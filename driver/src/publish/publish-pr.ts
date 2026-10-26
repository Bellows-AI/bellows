import { randomUUID } from 'node:crypto';
import type { BoardJob } from '../board/board.js';
import type { PrOperationKind, PrOperationWrite } from '../board/board-pr-operations.js';
import {
    baseBranchOf,
    CREDENTIAL_HELPER,
    isBranchName,
    parsePrSummary,
    prNumberFromUrl,
    prSummaryScript,
} from './publish-base.js';
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
 * workflow itself): reuse or open the branch's PR, retarget it, and the push with the publication
 * ledger and the remote read that keep a retried publish from repeating an effect that landed.
 */

/**
 * Where each managed PR operation is handed as it happens (issue #983): the loop's recorder writes it
 * to the board under the attempt's lease. It is best effort by contract — it logs its own failure and
 * a publish never depends on it.
 */
export type PrOperationRecorder = (note: PrOperationWrite) => Promise<void>;

/**
 * Hands one operation to the recorder, with an id minted for it, and answers that id for the publish
 * reply. Nothing is minted without a recorder or a PR the board could store (a number the url does not
 * carry, no repo label). A recorder that throws anyway leaves the operation unrecorded: the PR is
 * already open, and the publish must neither fail nor open another.
 */
async function notePrOperation(
    record: PrOperationRecorder | undefined,
    note: { job: BoardJob; branch: string; operation: PrOperationKind; prUrl: string | null }
): Promise<string | undefined> {
    const { job, branch, operation, prUrl } = note;
    const prNumber = prUrl === null ? null : prNumberFromUrl(prUrl);
    if (!record || !prUrl || prNumber === null || !job.repo) return undefined;
    const operationId = randomUUID();
    await record({ operationId, operation, repo: job.repo, prNumber, prUrl, branch }).catch(() => undefined);
    return operationId;
}

/**
 * The branch's open PR, whoever opened it — the agent with `gh pr create` or an earlier publish.
 * A `pr view` that fails is the ordinary "no PR yet", not a step failure.
 */
async function existingPrUrl(runStep: RunPublishStep, branch: string): Promise<string | null> {
    const existing = await runStep({
        label: 'gh pr view',
        entrypoint: 'gh',
        args: ['pr', 'view', branch, '--json', 'url', '-q', '.url'],
        env: true,
        inRepo: true,
    }).catch(() => null);
    return existing ? (existing.stdout.trim().split('\n').filter(Boolean).pop() ?? null) : null;
}

/**
 * Points a reused PR at the claim's base branch: the agent may have opened it with gh's default
 * base, and the board must never record (or automerge) a PR into a branch the task does not target.
 * Only an open PR on another base is edited — a merged or closed one cannot be, and one already on
 * the base needs nothing. A no-op without a base; a failed read or edit fails the publish.
 */
async function retargetPr(step: RunPublishStep, job: BoardJob, branch: string): Promise<void> {
    const base = baseBranchOf(job);
    if (!base) return;
    const read = await step({
        label: 'gh pr base',
        entrypoint: 'gh',
        args: ['pr', 'view', branch, '--json', 'state,baseRefName', '-q', '.state + " " + .baseRefName'],
        env: true,
        inRepo: true,
    });
    const [state, current] = read.stdout.trim().split(' ');
    if (state !== 'OPEN' || current === base) return;
    await step({
        label: 'gh pr edit',
        entrypoint: 'gh',
        args: ['pr', 'edit', branch, '--base', base],
        env: true,
        inRepo: true,
    });
}

/**
 * A clean, fully-pushed checkout on its task branch may still carry a PR the agent opened itself
 * (issue #573): the publication record names it, so the board links the one PR and a retry or a
 * resume reuses it instead of opening a second.
 */
export async function reconcileAgentPr(
    runStep: RunPublishStep,
    step: RunPublishStep,
    context: { job: BoardJob; state: GitState; record?: PrOperationRecorder | undefined }
): Promise<PublishResult | null> {
    const { job, state, record } = context;
    const { branch } = state;
    if (!branch || branch === state.defaultBranch || !isBranchName(branch)) return null;
    const prUrl = await existingPrUrl(runStep, branch);
    if (!prUrl) return null;
    await retargetPr(step, job, branch);
    const operationId = await notePrOperation(record, { job, branch, operation: 'reused', prUrl });
    return {
        ok: true,
        published: true,
        branch,
        prUrl,
        reason: null,
        repository: job.repo ?? null,
        baseBranch: state.defaultBranch ?? null,
        prNumber: prNumberFromUrl(prUrl),
        cause: null,
        ...(operationId ? { operationId } : {}),
    };
}

/**
 * Reuses the branch's PR when one exists — a task that already shipped its PR gets idempotent
 * publishes, not duplicates — or opens one summarized from the branch's own commits and diff.
 */
export async function resolveOrCreatePr(
    runStep: RunPublishStep,
    step: RunPublishStep,
    context: {
        job: BoardJob;
        branch: string;
        plan: PublishPlan;
        state: GitState;
        draft: boolean;
        op: string;
        record?: PrOperationRecorder | undefined;
    }
): Promise<{ prUrl: string | null; operationId?: string }> {
    const { job, branch, plan, state, draft, op, record } = context;
    const noted = async (prUrl: string | null, operation: PrOperationKind) => {
        const operationId = await notePrOperation(record, { job, branch, operation, prUrl });
        return { prUrl, ...(operationId ? { operationId } : {}) };
    };
    const reused = await existingPrUrl(runStep, branch);
    if (reused) {
        await retargetPr(step, job, branch);
        return noted(reused, 'reused');
    }

    // The PR speaks for the work, not for the command that started it (issue #82): a
    // summarizer script reads the branch — its commits and the diff against the default
    // — in the same throwaway-container shape as every other step. It needs no
    // credential (local git reads only) and its failure is decoration: the
    // command-derived plan title and the plain body stay the fallback. BACKSTOP_TITLE names
    // this publish's own just-created commit (its subject IS plan.title) so the script never
    // selects the command text as the title (issue #389) — the commit's work stays in the
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
    // A PR whose creation answered badly may exist all the same: the branch's PRs are read again
    // before the failure stands, so a retry never opens a second one.
    let opened = false;
    const prUrl = await reconciled(
        async () => {
            const created = await step({
                label: 'gh pr create',
                entrypoint: 'gh',
                args: [
                    'pr',
                    'create',
                    '--head',
                    branch,
                    ...(baseBranchOf(job) ? ['--base', state.defaultBranch] : []),
                    '--title',
                    title,
                    '--body',
                    body,
                    ...(draft ? ['--draft'] : []),
                ],
                env: true,
                inRepo: true,
                op,
            });
            const url = created.stdout.trim().split('\n').filter(Boolean).pop() ?? null;
            opened = url !== null;
            return url;
        },
        () => existingPrUrl(runStep, branch)
    );
    // An answer lost after the PR landed finds it by the read above: that is a reuse, not a second create.
    return noted(prUrl, opened ? 'created' : 'reused');
}

/**
 * Lands the branch's commit on the remote and records how far it got. The push is asked about
 * before it is repeated: one that failed may still have landed, and the remote's own head — not the
 * answer — decides. `pushing` is recorded before the effect, `pushed` after it.
 */
export async function pushRecorded(
    runStep: RunPublishStep,
    step: RunPublishStep,
    publication: { repo: string; branch: string; op: string; sha: string }
): Promise<void> {
    const { repo, branch, op, sha } = publication;
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
                        `credential.helper=${CREDENTIAL_HELPER}`,
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
                { branch, credentialHelper: CREDENTIAL_HELPER, sha }
            ),
        async () => ((await remoteHeadOf(runStep, branch, CREDENTIAL_HELPER)) === sha ? undefined : null)
    );
    await recordOperation(step, repo, op, { state: 'pushed' });
}

/** The published result of a branch whose pull request is `prUrl`. */
export const publishedResult = (
    job: BoardJob,
    branch: string,
    base: string | undefined,
    landed: { prUrl: string | null; operationId?: string }
): PublishResult => ({
    ok: true,
    published: true,
    branch,
    prUrl: landed.prUrl,
    reason: null,
    repository: job.repo ?? null,
    baseBranch: base ?? null,
    prNumber: prNumberFromUrl(landed.prUrl ?? ''),
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
        record?: PrOperationRecorder | undefined;
    }
): Promise<PublishResult | null> {
    const { job, repo, state, plan, draft, record } = context;
    const { branch } = state;
    if (!branch || branch === state.defaultBranch || !isBranchName(branch)) return null;
    const sha = await headSha(runStep);
    if (sha === null) return null;
    const op = publicationOp(branch, sha);
    // `pushing` counts too: the tree is clean and has nothing unpushed, so git itself says the push
    // landed — only its answer, and the ledger entry after it, were lost.
    const { state: reached } = await readOperation(runStep, repo, op);
    if (reached !== 'pushing' && reached !== 'pushed') return null;
    const landed = await resolveOrCreatePr(runStep, step, {
        job,
        branch,
        plan,
        state,
        draft,
        op,
        record,
    });
    await recordOperation(step, repo, op, { state: 'opened', ...(landed.prUrl ? { prUrl: landed.prUrl } : {}) });
    return publishedResult(job, branch, state.defaultBranch, landed);
}
