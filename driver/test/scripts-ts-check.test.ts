import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPTS = fileURLToPath(new URL('../src/scripts/', import.meta.url));

/**
 * Fragments the driver concatenates into one script at load time (`review/review-helpers.ts`): each reads names
 * its neighbours declare, so none type-checks alone. Stated limit: they join the check when the scripts are built from TS.
 */
const FRAGMENTS = [
    'review-collect-probe-postlude.cjs',
    'review-collect-probe-prelude.cjs',
    'review-reply-probe-middle.cjs',
    'review-reply-probe-postlude.cjs',
];

/** Scripts not yet typed (BEL-319, 10c). Only ever shrinks: a script that gains `// @ts-check` leaves it. */
const PENDING = new Set<string>([
    'attachment-extract.cjs',
    'attachment-fetch.cjs',
    'checkpoint-restore.cjs',
    'checkpoint.cjs',
    'claude-export.cjs',
    'git-harden.cjs',
    'git-probe.cjs',
    'merge-conflict-probe.cjs',
    'opencode-readout.cjs',
    'pr-summary.cjs',
    'review-collect.cjs',
    'review-reply.cjs',
    'skill-install.cjs',
    'supervisor.cjs',
    'task-checkout.cjs',
]);

const optedIn = (file: string): boolean =>
    readFileSync(join(SCRIPTS, file), 'utf8').split('\n', 3).includes('// @ts-check');

// `npm run typecheck` checks only the files that opt in, so a script that never does is untyped without a signal.
describe('driver container scripts carry // @ts-check', () => {
    const scripts = readdirSync(SCRIPTS).filter((file) => file.endsWith('.cjs'));

    it.each(scripts.filter((file) => !PENDING.has(file) && !FRAGMENTS.includes(file)))('%s opts in', (file) => {
        expect(optedIn(file)).toBe(true);
    });

    it.each([...PENDING, ...FRAGMENTS])('%s is listed only while it does not opt in', (file) => {
        expect(scripts).toContain(file);
        expect(optedIn(file)).toBe(false);
    });
});
