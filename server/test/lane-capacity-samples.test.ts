import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * scripts/lane-capacity-samples.mjs judges the capacity phases' once-a-second reads of the running rows
 * (issue #831): the budget held on every readable sample, a failed read is counted apart and is
 * never a zero, and the crash window must hold a readable sample.
 */
const SCRIPT = fileURLToPath(new URL('../../scripts/lane-capacity-samples.mjs', import.meta.url));

const verdict = (rows: string[], ...args: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'capacity-samples-'));
    const file = join(dir, 'samples');
    writeFileSync(file, `${rows.join('\n')}\n`);
    const run = spawnSync('node', [SCRIPT, file, ...args], { encoding: 'utf8' });
    return { status: run.status, out: JSON.parse(run.stdout) };
};

describe('lane-capacity-samples', () => {
    it('counts clean samples and the ones inside the crash window', () => {
        const { out, status } = verdict(['100|1|1|0', '101|2|2|0', '102|2|2|0', '103|2|2|0'], '101', '102');
        expect(status).toBe(0);
        expect(out).toEqual({
            readable: 4,
            unreadable: 0,
            over: 0,
            shared: 0,
            unslotted: 0,
            window: 2,
            windowUnreadable: 0,
            gap: 1,
            max: 2,
        });
    });

    it('counts a failed read apart and never as an empty database', () => {
        const { out } = verdict(['100|?', '101|2|2|0', 'garbage', '102|1'], '100', '102');
        expect(out).toMatchObject({ readable: 1, unreadable: 3, over: 0, window: 1, max: 2 });
    });

    it('flags a sample over the budget, a shared slot and a running row without one', () => {
        const { out } = verdict(['100|3|3|0', '101|2|1|0', '102|2|1|1'], '0', '0');
        expect(out).toMatchObject({ over: 1, shared: 2, unslotted: 1, max: 3 });
    });

    it('takes another budget as the fourth argument', () => {
        expect(verdict(['100|3|3|0'], '0', '0', '3').out.over).toBe(0);
    });

    it('reads an empty or non-numeric column as a failed read, never as zero', () => {
        const { out } = verdict(['100|||', '101||1|0', '102|a|1|0', '103|1|1|', '104|1|1|0|9', '105|1|1|0'], '0', '0');
        expect(out).toMatchObject({ readable: 1, unreadable: 5, over: 0, unslotted: 0 });
    });

    it('counts failed reads inside the crash window and the longest stretch with no readable sample', () => {
        const { out } = verdict(['100|1|1|0', '101|?', '102|?', '103|?', '120|2|2|0', '121|2|2|0'], '101', '121');
        expect(out).toMatchObject({ window: 2, windowUnreadable: 3, gap: 20 });
    });
});
