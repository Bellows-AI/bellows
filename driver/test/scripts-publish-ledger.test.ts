import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { containerScript } from '../src/container-scripts.js';

/**
 * The publication ledger (scripts/publish-ledger.cjs): the persisted operation identity a retried
 * or adopted publish reads before it pushes or opens anything (issue #771). Run for real, as the
 * supervisor runs it: `node -e <script>` with the operation in its environment.
 */
const SCRIPT = containerScript('publish-ledger.cjs');
const OP = `fix/10@${'a'.repeat(40)}`;
const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ledgerFile = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    dirs.push(dir);
    // `.factory/` does not exist yet: the script creates the namespace itself.
    return join(dir, '.factory', 'publication.json');
};

const run = (LEDGER: string, env: Record<string, string>): Record<string, string> =>
    JSON.parse(
        execFileSync('node', ['-e', SCRIPT], { env: { PATH: process.env.PATH!, LEDGER, ...env } }).toString()
    ) as Record<string, string>;

describe('the publication ledger script', () => {
    it('answers an operation it never saw with nothing', () => {
        expect(run(ledgerFile(), { ACTION: 'read', OP })).toEqual({});
    });

    it('records how far an operation got, and a later read answers it', () => {
        const file = ledgerFile();
        expect(run(file, { ACTION: 'write', OP, STATE: 'pushing' })).toMatchObject({ state: 'pushing' });
        run(file, { ACTION: 'write', OP, STATE: 'opened', PR_URL: 'https://github.com/o/r/pull/7' });
        expect(run(file, { ACTION: 'read', OP })).toMatchObject({
            state: 'opened',
            prUrl: 'https://github.com/o/r/pull/7',
        });
    });

    it('never moves an operation backwards: a retried `pushing` after `pushed` keeps `pushed`', () => {
        const file = ledgerFile();
        run(file, { ACTION: 'write', OP, STATE: 'pushed' });
        expect(run(file, { ACTION: 'write', OP, STATE: 'pushing' })).toMatchObject({ state: 'pushed' });
    });

    it('keeps operations apart, by branch and commit', () => {
        const file = ledgerFile();
        run(file, { ACTION: 'write', OP, STATE: 'pushed' });
        expect(run(file, { ACTION: 'read', OP: `fix/10@${'b'.repeat(40)}` })).toEqual({});
    });

    it('survives a torn or unreadable ledger by starting a fresh one', () => {
        const file = ledgerFile();
        run(file, { ACTION: 'write', OP, STATE: 'pushed' });
        execFileSync('sh', ['-c', `printf '{"operations":' > '${file}'`]);
        expect(run(file, { ACTION: 'read', OP })).toEqual({});
    });

    it('refuses a write that names no valid state, exiting non-zero with the reason', () => {
        const result = spawnSync('node', ['-e', SCRIPT], {
            env: { PATH: process.env.PATH!, LEDGER: ledgerFile(), ACTION: 'write', OP, STATE: 'done' },
        });
        expect(result.status).toBe(1);
        expect(result.stderr.toString()).toMatch(/not a ledger write/);
    });
});
