import { type Ledger, readLedger, writeLedger } from './operation-ledger.js';
import type { RunPublishStep } from './publish.js';

/**
 * Publication reconciliation (issue #771). A publish is a chain of effects on a remote — the push,
 * then the pull request — and each can land while its answer is lost (a timeout, a dropped channel,
 * a supervisor that died after the remote accepted). Retrying blind would push or open twice, and a
 * retry that only trusts the local tree would never open a pull request whose push already landed.
 * So a publication carries a persisted operation identity, `<branch>@<commit sha>`, recorded in the
 * task worktree's operation ledger (`operation-ledger.ts`) as it moves through `pushing`, `pushed`
 * and `opened`; and after any failed or uncertain effect the remote is asked what it has before
 * anything is repeated.
 */

export type OperationState = 'pushing' | 'pushed' | 'opened';

/** The publication ledger, in the worktree's own `.factory/` namespace (never staged: the sync excludes it). */
const PUBLICATION_LEDGER: Ledger = {
    label: 'publication ledger',
    file: '.factory/publication.json',
    states: ['pushing', 'pushed', 'opened'] satisfies OperationState[],
};

/** What the ledger holds for one operation; empty when the operation was never recorded. */
export interface OperationRecord {
    state?: OperationState;
    prUrl?: string;
}

/** The identity of one publication: the branch and the exact commit it pushes. */
export const publicationOp = (branch: string, sha: string): string => `${branch}@${sha}`;

const SHA = /^[0-9a-f]{40,64}$/;

/** The commit HEAD names, or null when it cannot be read as one. */
export async function headSha(step: RunPublishStep): Promise<string | null> {
    const read = await step({
        label: 'git rev-parse HEAD',
        entrypoint: 'git',
        args: ['rev-parse', 'HEAD'],
        env: false,
        inRepo: true,
    }).catch(() => null);
    const sha = read?.stdout.trim() ?? '';
    return SHA.test(sha) ? sha : null;
}

/** What the ledger says about an operation; unreadable reads as "never recorded", never as progress. */
export async function readOperation(step: RunPublishStep, repo: string, op: string): Promise<OperationRecord> {
    // A read the supervisor lost reads as never recorded here too: the remote read reconciles it.
    const record = (await readLedger({ step, repo, ledger: PUBLICATION_LEDGER }, op).catch(
        () => ({})
    )) as OperationRecord;
    return { ...(record.state ? { state: record.state } : {}), ...(record.prUrl ? { prUrl: record.prUrl } : {}) };
}

/**
 * Records how far an operation got. A ledger that cannot be written fails the publish before the
 * effect it would have recorded: an unrecorded push is the one a retry could not reconcile.
 */
export async function recordOperation(
    step: RunPublishStep,
    repo: string,
    op: string,
    progress: { state: OperationState; prUrl?: string }
): Promise<void> {
    const data = progress.prUrl ? { prUrl: progress.prUrl } : undefined;
    await writeLedger({ step, repo, ledger: PUBLICATION_LEDGER }, op, progress.state, data);
}

/** The commit the remote holds for `branch`, or null when it has none or cannot be asked. */
export async function remoteHeadOf(
    step: RunPublishStep,
    branch: string,
    credentialHelper: string
): Promise<string | null> {
    const read = await step({
        label: 'git ls-remote',
        entrypoint: 'git',
        args: ['-c', `credential.helper=${credentialHelper}`, 'ls-remote', 'origin', `refs/heads/${branch}`],
        env: true,
        inRepo: true,
    }).catch(() => null);
    const sha = read?.stdout.trim().split(/\s+/)[0] ?? '';
    return SHA.test(sha) ? sha : null;
}

/**
 * Runs one effect and, when it fails, asks `landed` whether it happened anyway: a landed effect is
 * a success whatever the answer said, and one that did not is the original failure, rethrown. This
 * is the whole "uncertain response" rule — nothing is repeated before the remote has been asked.
 */
export async function reconciled<T>(effect: () => Promise<T>, landed: () => Promise<T | null>): Promise<T> {
    try {
        return await effect();
    } catch (error) {
        const found = await landed().catch(() => null);
        if (found !== null) return found;
        throw error;
    }
}
