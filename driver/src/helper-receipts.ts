import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { BoardJob } from './board.js';
import { type HelperPlan, type HelperResult, helperInputValue } from './helpers.js';
import { type Ledger, type LedgerAt, readLedger, writeLedger } from './operation-ledger.js';
import type { RunPublishStep } from './publish.js';
import { commandMark } from './runner.js';
import { stepLost } from './step-control.js';

/**
 * Block-helper receipts (issue #826). A receipted helper's run is an external effect, and a claim
 * can be lost anywhere around it: before the write, after it but before anyone heard, or after.
 * Its replacement — a new lease, a new pod, maybe a new driver — needs a name for the effect that
 * is the same on every claim of the job (`helperEffectId`; a step id carries its attempt's lease,
 * so it cannot be that name) and a record of how far the effect got, on the task volume.
 *
 * `started` is written before the helper runs and `done`, with its result, only once it answered.
 * A `done` effect is answered from its receipt and never runs again; a `started` one is uncertain
 * and runs again — the helper itself reads the remote before it writes (its own markers), which is
 * the only thing that keeps an uncertain write from landing twice. No exactly-once write is claimed.
 *
 * The receipt sits where the agent can write, so a recorded result carries a MAC under the driver's
 * board token, which no runner container holds: a receipt that does not verify reads as never
 * recorded, which re-runs the helper rather than replaying a result nobody can vouch for. A driver
 * with no board token keeps no receipts at all (`runHelperStep`): every claim runs the helper.
 */

const HELPER_LEDGER: Ledger = {
    label: 'helper ledger',
    file: '.factory/helpers.json',
    states: ['started', 'done'],
};

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * The logical effect one helper call performs: the job, its command, and where the call sits in
 * the job's declared plans (its phase, the plan's index there, the child's index in the plan).
 * Never the lease, the claim sequence or the attempt — that is what makes it the same name on the
 * claim that lost the effect and the one that takes the job over.
 */
export const helperEffectId = (job: BoardJob, plan: HelperPlan, planIndex: number, childIndex: number): string =>
    sha256(
        [
            job.id,
            commandMark(job.command),
            plan.phase,
            planIndex,
            childIndex,
            plan.helperId,
            helperInputValue(plan),
        ].join('|')
    );

const macOf = (key: string, effectId: string, result: string): string =>
    createHmac('sha256', key).update(`factory-helper-receipt/v1\n${effectId}\n${result}`).digest('hex');

/** The result a `done` receipt vouches for, or null when it holds none the driver can verify. */
function recordedResult(record: Record<string, unknown>, key: string, effectId: string): HelperResult | null {
    const { state, result, mac } = record;
    if (state !== 'done' || typeof result !== 'string' || typeof mac !== 'string') return null;
    const expected = Buffer.from(macOf(key, effectId, result));
    const given = Buffer.from(mac);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
        const parsed = JSON.parse(result) as HelperResult;
        return parsed.ok === true ? parsed : null;
    } catch {
        return null;
    }
}

/** Where one helper call's receipt lives: the worktree, the MAC key, and the call's effect. */
export interface HelperReceipt {
    worktree: string;
    key: string;
    effectId: string;
}

/**
 * Runs one receipted helper call (`run`) bracketed by its receipt. A `started` write that fails
 * runs nothing, since an effect with no receipt is one a replacement could not reconcile; a lost
 * supervisor is thrown at any of the three steps, never answered as a helper failure. A `done`
 * write that otherwise fails leaves the effect `started`, which the next claim re-runs and the
 * helper reconciles.
 */
export async function withHelperReceipt(
    step: RunPublishStep,
    { worktree, key, effectId }: HelperReceipt,
    run: () => Promise<HelperResult>
): Promise<HelperResult> {
    const at: LedgerAt = { step, repo: worktree, ledger: HELPER_LEDGER };
    const recorded = recordedResult(await readLedger(at, effectId), key, effectId);
    if (recorded) return recorded;
    try {
        await writeLedger(at, effectId, 'started');
    } catch (e) {
        if (stepLost(e)) throw e;
        return {
            ok: false,
            reason: 'runner_error',
            message: `the helper's receipt could not be recorded, so it did not run: ${(e as Error).message}`,
        };
    }
    const result = await run();
    if (result.ok) {
        const text = JSON.stringify(result);
        await writeLedger(at, effectId, 'done', { result: text, mac: macOf(key, effectId, text) }).catch((e) => {
            if (stepLost(e)) throw e;
        });
    }
    return result;
}
