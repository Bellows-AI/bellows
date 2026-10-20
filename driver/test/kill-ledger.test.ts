import { describe, expect, it } from 'vitest';
import { createKillLedger } from '../src/kill-ledger.js';
import type { KillRecord } from '../src/termination.js';
import { boardJob } from './fixtures/board-job.js';

const job = (over: { id?: string; leaseToken?: string } = {}) => ({ ...boardJob(), ...over });

/** The executor's durable write, faked: a volume or annotation per (lease, reason). */
function fakeStore() {
    const written: Array<{ lease: string; kill: KillRecord }> = [];
    return {
        written,
        write: async (j: { leaseToken: string }, kill: KillRecord) => {
            written.push({ lease: j.leaseToken, kill });
        },
    };
}

describe('the kill ledger', () => {
    it('knows nothing of an attempt it was not told about', () => {
        const ledger = createKillLedger(fakeStore());
        expect(ledger.was(job({ leaseToken: 'a' }))).toEqual({ stopped: false, hard: false });
    });

    it('notes a supervised stop apart from a hard kill; a hard kill is also a stop', () => {
        const ledger = createKillLedger(fakeStore());
        ledger.note(job({ leaseToken: 'a' }), 'stopped');
        ledger.note(job({ leaseToken: 'b' }), 'hard');
        expect(ledger.was(job({ leaseToken: 'a' }))).toEqual({ stopped: true, hard: false });
        expect(ledger.was(job({ leaseToken: 'b' }))).toEqual({ stopped: true, hard: true });
    });

    it('keeps one attempt per lease: a kill never reaches the same job under another lease', () => {
        const ledger = createKillLedger(fakeStore());
        ledger.note(job({ id: 'j', leaseToken: 'a' }), 'hard');
        expect(ledger.was(job({ id: 'j', leaseToken: 'b' })).stopped).toBe(false);
    });

    it('forgets one lease and leaves the others', () => {
        const ledger = createKillLedger(fakeStore());
        ledger.note(job({ leaseToken: 'a' }), 'hard');
        ledger.note(job({ leaseToken: 'b' }), 'hard');
        ledger.forget(job({ leaseToken: 'a' }));
        expect(ledger.was(job({ leaseToken: 'a' }))).toEqual({ stopped: false, hard: false });
        expect(ledger.was(job({ leaseToken: 'b' })).hard).toBe(true);
    });

    it('records through the executor write', async () => {
        const store = fakeStore();
        const ledger = createKillLedger(store);
        await ledger.record(job({ leaseToken: 'a' }), { reason: 'timeout', detail: 'd' });
        expect(store.written).toEqual([{ lease: 'a', kill: { reason: 'timeout', detail: 'd' } }]);
    });

    it('rejects a refused write as it comes', async () => {
        const ledger = createKillLedger({
            write: async () => {
                throw new Error('refused write');
            },
        });
        await expect(ledger.record(job(), { reason: 'timeout', detail: '' })).rejects.toThrow('refused write');
    });

    it('two runner instances addressing one attempt do not see each other kills', () => {
        const one = createKillLedger(fakeStore());
        const other = createKillLedger(fakeStore());
        one.note(job({ id: 'j', leaseToken: 'a' }), 'hard');
        expect(one.was(job({ id: 'j', leaseToken: 'a' })).hard).toBe(true);
        expect(other.was(job({ id: 'j', leaseToken: 'a' }))).toEqual({ stopped: false, hard: false });
    });
});
