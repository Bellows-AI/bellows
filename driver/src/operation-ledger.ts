import { containerScript } from './container-scripts.js';
import type { PublishStep, RunPublishStep } from './publish.js';
import { stepLost } from './step-control.js';

/**
 * The supervised half of the operation ledger (scripts/operation-ledger.cjs): one JSON file in the
 * task worktree's `.factory/` namespace, on the task volume, so an adopted or retried attempt — a
 * new pod, a new driver — reads what the lost one did. Publication (`publish-reconcile.ts`) and
 * block-helper receipts (`helper-receipts.ts`) each keep their own file and their own states.
 */

const operationLedgerScript = containerScript('operation-ledger.cjs');

/** One ledger: its step label, its file in the worktree, and its states in order. */
export interface Ledger {
    label: string;
    file: string;
    states: readonly string[];
}

/** A ledger in one task worktree, reached through the attempt's supervised steps. */
export interface LedgerAt {
    step: RunPublishStep;
    repo: string;
    ledger: Ledger;
}

const ledgerStep = ({ repo, ledger }: LedgerAt, op: string, extra: Record<string, string>): PublishStep => ({
    label: ledger.label,
    entrypoint: 'node',
    args: ['-e', operationLedgerScript],
    env: false,
    envLiterals: { LEDGER: `${repo}/${ledger.file}`, OP: op, STATES: ledger.states.join(','), ...extra },
    inRepo: false,
});

/**
 * What the ledger holds for an operation; unreadable reads as "never recorded", never as progress.
 * A lost supervisor (`stepLost`) is thrown: that is no answer about the ledger at all.
 */
export async function readLedger(at: LedgerAt, op: string): Promise<Record<string, unknown>> {
    const read = await at.step(ledgerStep(at, op, { ACTION: 'read' })).catch((e: unknown) => {
        if (stepLost(e)) throw e;
        return null;
    });
    try {
        const record: unknown = JSON.parse(read?.stdout.trim().split('\n').pop() ?? '{}');
        return typeof record === 'object' && record !== null ? (record as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

/** Records how far an operation got, with `data` merged into its record; a failed write throws. */
export async function writeLedger(
    at: LedgerAt,
    op: string,
    state: string,
    data?: Record<string, unknown>
): Promise<void> {
    await at.step(
        ledgerStep(at, op, { ACTION: 'write', STATE: state, ...(data ? { DATA: JSON.stringify(data) } : {}) })
    );
}
