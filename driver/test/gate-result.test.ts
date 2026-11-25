import { describe, expect, it } from 'vitest';
import { compactResult, describeResult, gateResultOf, resourcesOf } from '../src/gate-result.js';

const line = (s: { t: number; cpu: string; load: number; avail: number; throttled: string }): string =>
    `t=${s.t} cpu=${s.cpu} load=${s.load} mem=${s.avail}/4096000 throttled=${s.throttled}\n`;

describe('gateResultOf', () => {
    it('is undefined for a gate that left no report', () => {
        expect(gateResultOf(undefined, false)).toBeUndefined();
        expect(gateResultOf({ sections: {}, resources: '' }, false)).toBeUndefined();
    });

    it('lists the failures, the selection and the ten slowest files, slowest first', () => {
        const files = Array.from({ length: 12 }, (_, i) => ({ file: `f${i}.test.ts`, ms: (i + 1) * 100 }));
        const result = gateResultOf(
            {
                sections: {
                    tests: { failures: [{ file: 'a.test.ts', test: 'adds', message: 'expected 1 to be 2' }], files },
                    selection: { mode: 'all', reason: 'a shared file changed' },
                },
                resources: '',
            },
            false
        );
        expect(result?.failures).toEqual([{ file: 'a.test.ts', test: 'adds', message: 'expected 1 to be 2' }]);
        expect(result?.selection).toEqual({ mode: 'all', reason: 'a shared file changed' });
        expect(result?.slowest).toHaveLength(10);
        expect(result?.slowest?.[0]).toEqual({ file: 'f11.test.ts', ms: 1200 });
        expect(result?.slowest?.[9]).toEqual({ file: 'f2.test.ts', ms: 300 });
        expect(result?.inFlight).toBeUndefined();
    });

    it('counts the failures beyond the ones listed, and carries the count to the compact and the text form', () => {
        const failures = Array.from({ length: 3 }, (_, i) => ({ file: 'a', test: `t${i}`, message: 'm' }));
        const result = gateResultOf({ sections: { tests: { failures, failureCount: 90 } }, resources: '' }, false);
        expect(result?.moreFailures).toBe(87);
        expect(describeResult(result)).toContain('Failed tests (90):');
        expect(describeResult(result)).toContain('+87 more');
        const many = { failures: Array.from({ length: 30 }, (_, i) => ({ file: 'a', test: `t${i}`, message: 'm' })) };
        expect(compactResult({ ...many, moreFailures: 5 }).moreFailures).toBe(25);
    });

    it('names the files still in flight only for a gate killed at its deadline', () => {
        const report = { sections: { tests: { inFlight: ['slow.test.ts'] } }, resources: '' };
        expect(gateResultOf(report, true)?.inFlight).toEqual(['slow.test.ts']);
        expect(gateResultOf(report, false)).toBeUndefined();
    });

    it('bounds what it keeps and drops what is the wrong shape', () => {
        const failures = Array.from({ length: 80 }, (_, i) => ({
            file: 'a',
            test: `t${i}`,
            message: 'x'.repeat(5000),
        }));
        const result = gateResultOf(
            { sections: { tests: { failures: [...failures, 7, { file: 1 }] }, selection: { mode: 3 } }, resources: '' },
            false
        );
        expect(result?.failures).toHaveLength(50);
        expect(result?.failures?.[0]?.message.length).toBeLessThanOrEqual(1000);
        expect(result?.selection).toBeUndefined();
    });
});

describe('resourcesOf', () => {
    it('summarises the guest between the first and the last sample as shares of the window', () => {
        const samples =
            line({ t: 100, cpu: '100,0,100,700,50,0,0,50', load: 0.5, avail: 3_000_000, throttled: '2,1000' }) +
            line({ t: 110, cpu: '200,0,200,800,100,0,0,100', load: 2.5, avail: 1_000_000, throttled: '5,4000' }) +
            line({ t: 120, cpu: '300,0,300,900,200,0,0,250', load: 1.5, avail: 2_000_000, throttled: '9,9000' });
        // Window deltas: user 200, system 200, idle 200, iowait 150, steal 200 of 950 jiffies.
        const resources = resourcesOf(samples);
        expect(resources).toMatchObject({
            samples: 3,
            seconds: 20,
            cpu: { user: 21.1, system: 21.1, iowait: 15.8, steal: 21.1, idle: 21.1 },
            throttledPeriods: 7,
            throttledMs: 8,
            load: { start: 0.5, max: 2.5, end: 1.5 },
            memAvailableMb: { min: 977, end: 1953 },
            memTotalMb: 4000,
        });
    });

    it('ignores a malformed line and answers undefined for fewer than one sample', () => {
        expect(resourcesOf('')).toBeUndefined();
        expect(resourcesOf('garbage\n')).toBeUndefined();
        const one = resourcesOf(line({ t: 5, cpu: '1,0,1,1,0,0,0,0', load: 0.1, avail: 1024, throttled: '0,0' }));
        expect(one).toMatchObject({ samples: 1, seconds: 0 });
        expect(one?.cpu).toBeUndefined();
    });
});
