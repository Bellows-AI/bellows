import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FIXTURE = fileURLToPath(new URL('./fixtures/suspend-outage.ts', import.meta.url));
const DRIVER = fileURLToPath(new URL('..', import.meta.url));

// Issue #820: a board outage on suspend once escaped runJob as an unhandled rejection, and a real
// Node process exits 1 on one — every other claim the driver held went with it. Only a real child
// proves the default unhandled-rejection mode does not fire.
describe('a driver process through a board outage on suspend', () => {
    it('stays alive, completes the other claim and never rejects unhandled', () => {
        const child = spawnSync(process.execPath, ['--import', 'tsx', FIXTURE], {
            cwd: DRIVER,
            encoding: 'utf8',
            timeout: 30_000,
        });

        expect(child.stderr).not.toMatch(/unhandled|Unhandled/);
        expect(child.status).toBe(0);
        expect(child.stdout).toContain('completed 00000002-1111-4111-8111-111111111111');
        expect(child.stdout).toContain('the board did not take the stop, left to the lease');
        expect(child.stdout).toMatch(/alive\n$/);
    }, 40_000);
});
