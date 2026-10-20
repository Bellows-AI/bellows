import { describe, expect, it } from 'vitest';
import { type LedgerAt, readLedger } from '../src/operation-ledger.js';
import { StepChannelClosed } from '../src/step-control.js';

const LEDGER = { label: 'ledger', file: '.factory/ledger.json', states: ['started', 'done'] };

/** A ledger whose read step answers `stdout`, or rejects with `error`. */
const at = (answer: { stdout: string } | { error: unknown }): LedgerAt => ({
    repo: '/workspace/repo',
    ledger: LEDGER,
    step: () => ('error' in answer ? Promise.reject(answer.error) : Promise.resolve({ stdout: answer.stdout })),
});

describe('readLedger', () => {
    it('reads the record on the last line of the step’s stdout', async () => {
        const stdout = '{"state":"started"}\n{"state":"done","pr":7}\n';
        expect(await readLedger(at({ stdout }), 'publish')).toEqual({ state: 'done', pr: 7 });
    });

    it('reads a null or unparseable last line as never recorded', async () => {
        expect(await readLedger(at({ stdout: 'null' }), 'publish')).toEqual({});
        expect(await readLedger(at({ stdout: 'nope' }), 'publish')).toEqual({});
        expect(await readLedger(at({ stdout: '' }), 'publish')).toEqual({});
    });

    it('reads an array record as never recorded', async () => {
        expect(await readLedger(at({ stdout: '[1]' }), 'publish')).toEqual({});
    });

    it('reads a failed step as never recorded, and rethrows a lost supervisor', async () => {
        expect(await readLedger(at({ error: new Error('exit 1') }), 'publish')).toEqual({});
        const lost = new StepChannelClosed('the read');
        await expect(readLedger(at({ error: lost }), 'publish')).rejects.toBe(lost);
    });
});
