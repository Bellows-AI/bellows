import { containerScript } from './container-scripts.js';
import type { PublishStep, RunPublishStep } from './publish.js';

/**
 * Publication reconciliation (issue #771). A publish is a chain of effects on a remote — the push,
 * then the pull request — and each can land while its answer is lost (a timeout, a dropped channel,
 * a supervisor that died after the remote accepted). Retrying blind would push or open twice, and a
 * retry that only trusts the local tree would never open a pull request whose push already landed.
 * So a publication carries a persisted operation identity, `<branch>@<commit sha>`, recorded in the
 * task worktree's `.factory/` namespace (scripts/publish-ledger.cjs) as it moves through `pushing`,
 * `pushed` and `opened`; and after any failed or uncertain effect the remote is asked what it has
 * before anything is repeated. The ledger lives on the task volume, so an adopted or retried
 * attempt — a new pod, a new driver — reads what the lost one did.
 */

/** The ledger script: see scripts/publish-ledger.cjs. */
const publishLedgerScript = containerScript('publish-ledger.cjs');

/** The ledger's file, in the worktree's own `.factory/` namespace (never staged: the sync excludes it). */
const LEDGER_FILE = '.factory/publication.json';

export type OperationState = 'pushing' | 'pushed' | 'opened';

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

const ledgerStep = (repo: string, op: string, extra: Record<string, string>): PublishStep => ({
    label: 'publication ledger',
    entrypoint: 'node',
    args: ['-e', publishLedgerScript],
    env: false,
    envLiterals: { LEDGER: `${repo}/${LEDGER_FILE}`, OP: op, ...extra },
    inRepo: false,
});

/** What the ledger says about an operation; unreadable reads as "never recorded", never as progress. */
export async function readOperation(step: RunPublishStep, repo: string, op: string): Promise<OperationRecord> {
    const read = await step(ledgerStep(repo, op, { ACTION: 'read' })).catch(() => null);
    try {
        const record = JSON.parse(read?.stdout.trim().split('\n').pop() ?? '{}') as OperationRecord;
        return { ...(record.state ? { state: record.state } : {}), ...(record.prUrl ? { prUrl: record.prUrl } : {}) };
    } catch {
        return {};
    }
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
    await step({
        ...ledgerStep(repo, op, {
            ACTION: 'write',
            STATE: progress.state,
            ...(progress.prUrl ? { PR_URL: progress.prUrl } : {}),
        }),
    });
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
