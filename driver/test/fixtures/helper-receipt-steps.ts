import type { StepRequest, StepResult } from '../../src/supervisor-contract.js';

/**
 * The supervisor side of a receipted helper (issue #826), shared by the executor suites: an empty
 * receipt ledger that takes every write, and a reply helper that answers it replied.
 */
const REPLIED_VERDICT = JSON.stringify({
    schema: 'review-reply-probe/v1',
    version: 1,
    ok: true,
    output: 'REVIEW-REPLIED',
    control: 'conclude',
});

export const receiptedAnswer = (step: StepRequest): StepResult => ({
    exitCode: 0,
    stdout: step.env.LEDGER ? '{}\n' : `${REPLIED_VERDICT}\n`,
    stderr: '',
    timedOut: false,
});

/** The helper-kind steps in submission order: `read`, `started`, `done`, or `helper` for the helper itself. */
export const receiptOrder = (steps: StepRequest[]): string[] =>
    steps
        .filter((step) => step.kind === 'helper')
        .map((step) => {
            if (!step.env.LEDGER) return 'helper';
            return step.env.ACTION === 'read' ? 'read' : String(step.env.STATE);
        });
