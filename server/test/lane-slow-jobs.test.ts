import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * scripts/lane-slow-jobs.mjs reads a lane's driver.log and names the attempts that held a slot
 * longer than a threshold, and those that never ended (issue #829): a stall costs a line in the
 * run's output instead of a re-run to catch it live.
 */
const SCRIPT = fileURLToPath(new URL('../../scripts/lane-slow-jobs.mjs', import.meta.url));
const T0 = 1_700_000_000_000;

const line = (job: string, claimSeq: number, step: string, atSeconds: number): string => {
    const [from, to] = step.split('>');
    return JSON.stringify({
        event: 'attempt-transition',
        job,
        claimSeq,
        from,
        to,
        ending: null,
        at: T0 + atSeconds * 1000,
    });
};

const report = (log: string[], ...args: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'slow-jobs-'));
    const file = join(dir, 'driver.log');
    writeFileSync(file, `${log.join('\n')}\n`);
    const run = spawnSync('node', [SCRIPT, file, ...args], { encoding: 'utf8' });
    return { status: run.status, out: run.stdout };
};

describe('lane-slow-jobs', () => {
    it('names an attempt whose launched to ended span passes the threshold, and not a quick one', () => {
        const { out, status } = report([
            'driver: started',
            line('job-slow', 1, 'setup>launched', 1),
            line('job-slow', 1, 'launched>ended', 61),
            line('job-fast', 1, 'setup>launched', 2),
            line('job-fast', 1, 'launched>ended', 5),
        ]);
        expect(status).toBe(0);
        expect(out).toContain('job-slow claim 1: 60s launched to ended');
        expect(out).not.toContain('job-fast');
        expect(out).toContain('1 slow, 0 never ended (threshold 30s)');
    });

    it('keeps each claim of one job apart and reads a line behind a log prefix', () => {
        const { out } = report([
            `2026-10-21T10:00:00Z [driver] ${line('job-a', 1, 'setup>launched', 0)}`,
            line('job-a', 1, 'launched>ended', 10),
            line('job-a', 2, 'setup>launched', 12),
            line('job-a', 2, 'launched>ended', 100),
        ]);
        expect(out).toContain('job-a claim 2: 88s launched to ended');
        expect(out).not.toContain('job-a claim 1');
    });

    it('lists an attempt that never ended with how long it was seen for', () => {
        const { out } = report([
            line('job-open', 1, 'setup>launched', 0),
            line('job-open', 1, 'launched>concluding', 90),
            line('job-quiet', 1, 'setup>launched', 0),
        ]);
        expect(out).toContain('job-open claim 1: never ended, last seen 90s after launch (concluding)');
        expect(out).toContain('job-quiet claim 1: never ended, last seen 0s after launch (launched)');
        expect(out).toContain('0 slow, 2 never ended (threshold 30s)');
    });

    it('takes the threshold as its second argument and ignores lines that are not transitions', () => {
        const { out } = report(
            [
                '{"event":"other"}',
                '{"event":"attempt-transition", broken',
                line('job-x', 1, 'setup>launched', 0),
                line('job-x', 1, 'launched>ended', 12),
            ],
            '10'
        );
        expect(out).toContain('job-x claim 1: 12s launched to ended');
        expect(out).toContain('(threshold 10s)');
    });

    it('reports a missing log as an empty run and still exits 0', () => {
        const run = spawnSync('node', [SCRIPT, '/nonexistent/driver.log'], { encoding: 'utf8' });
        expect(run.status).toBe(0);
        expect(run.stdout).toContain('0 slow, 0 never ended (threshold 30s)');
    });
});
