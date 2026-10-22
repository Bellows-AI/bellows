import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { runTimeoutMs, setupTimeoutMs } from '../src/claim.js';
import { setupSpentNote } from '../src/loop-verdict.js';
import { agentBackstopMs } from '../src/supervisor-plan.js';
import { SUPERVISOR_WINDDOWN_MS } from '../src/supervisor-contract.js';

/**
 * Issue #733: environment.setup runs before the agent, inside the run budget. Its own timeout keeps
 * a reserve for the agent — the gate budget, but never more than half the run's — and the runner's
 * deadline is what the setup left.
 */

const MINUTE = 60_000;
const job = { id: 'j' } as BoardJob;
const config = (jobTimeoutMs: number, gateTimeoutMs: number) => ({ jobTimeoutMs, gateTimeoutMs });

describe('setupTimeoutMs', () => {
    it('is the gate budget when that is under half the run budget', () => {
        expect(setupTimeoutMs(config(120 * MINUTE, 10 * MINUTE))).toBe(10 * MINUTE);
    });

    it('is half the run budget, floored, when the gate budget is larger', () => {
        expect(setupTimeoutMs(config(15 * MINUTE + 1, 60 * MINUTE))).toBe(7.5 * MINUTE);
    });
});

describe('runTimeoutMs after setup', () => {
    it('is the whole run budget when no setup ran', () => {
        expect(runTimeoutMs(config(10 * MINUTE, MINUTE), job)).toBe(10 * MINUTE);
    });

    it('takes the time setup spent off the run budget', () => {
        expect(runTimeoutMs(config(10 * MINUTE, MINUTE), { ...job, setupMs: 3 * MINUTE })).toBe(7 * MINUTE);
    });
});

describe('agentBackstopMs of a taken-over run (#829)', () => {
    const cfg = config(10 * MINUTE, MINUTE) as never;

    it('takes the budget the run already spent off, keeping the wind-down', () => {
        expect(agentBackstopMs(cfg, job)).toBe(10 * MINUTE + SUPERVISOR_WINDDOWN_MS);
        expect(agentBackstopMs(cfg, job, 4 * MINUTE)).toBe(6 * MINUTE + SUPERVISOR_WINDDOWN_MS);
    });

    it('floors an overspent budget at the wind-down alone', () => {
        expect(agentBackstopMs(cfg, job, 11 * MINUTE)).toBe(SUPERVISOR_WINDDOWN_MS);
    });
});

describe('setupSpentNote', () => {
    it('names the whole run budget, even when what setup left was clamped to the floor', () => {
        const note = setupSpentNote(config(MINUTE, MINUTE), { ...job, setupMs: 59_500 });
        expect(note).toBe('[driver] 59500ms of the 60000ms run budget went to environment.setup');
    });

    it('is empty when no setup ran', () => {
        expect(setupSpentNote(config(MINUTE, MINUTE), job)).toBe('');
    });
});
