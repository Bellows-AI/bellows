import { describe, expect, it } from 'vitest';
import { validateGates } from '../src/routes/jobs/job-gate-validation.js';

const entry = (result: unknown) => ({ name: 'test', status: 'failed', exitCode: 1, output: 'tail', result });

describe('validateGates: the structured result of a gate entry', () => {
    it('stores a well-formed result, bounded', () => {
        const checked = validateGates([
            entry({
                failures: [{ file: 'a.test.ts', test: 'adds', message: 'm'.repeat(5000) }, { file: 1 }],
                selection: { mode: 'all', reason: 'a shared file changed' },
                slowest: [{ file: 'a.test.ts', ms: 1500 }],
                resources: {
                    samples: 2,
                    seconds: 10,
                    cpu: { user: 10, system: 29, iowait: 24, steal: 20, idle: 17 },
                    throttledPeriods: 0,
                    throttledMs: 0,
                    load: { start: 1, max: 2, end: 1 },
                    memAvailableMb: { min: 100, end: 200 },
                    memTotalMb: 4000,
                },
            }),
        ]);
        expect(checked.ok).toBe(true);
        const result = checked.ok ? checked.value[0]?.result : undefined;
        expect(result?.failures).toHaveLength(1);
        expect(result?.failures?.[0]?.message).toHaveLength(1000);
        expect(result?.selection?.mode).toBe('all');
        expect(result?.resources?.cpu?.steal).toBe(20);
    });

    it('drops a result that is not one, and keeps the entry', () => {
        for (const bad of ['text', 7, [], {}, { failures: 'x' }, { resources: { samples: 1 } }]) {
            const checked = validateGates([entry(bad)]);
            expect(checked.ok).toBe(true);
            expect(checked.ok && 'result' in checked.value[0]!).toBe(false);
        }
    });
});
