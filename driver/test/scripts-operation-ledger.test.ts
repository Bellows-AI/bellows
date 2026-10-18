import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { containerScript } from '../src/container-scripts.js';

/**
 * The operation ledger (scripts/operation-ledger.cjs): the persisted identity a retried or adopted
 * publish (issue #771) or block-helper effect (issue #826) reads before it repeats anything. Run for
 * real, as the supervisor runs it: `node -e <script>` with the operation in its environment.
 */
const SCRIPT = containerScript('operation-ledger.cjs');
const OP = `fix/10@${'a'.repeat(40)}`;
const PUBLICATION = 'pushing,pushed,opened';
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

const run = (LEDGER: string, env: Record<string, string>): Record<string, unknown> =>
    JSON.parse(
        execFileSync('node', ['-e', SCRIPT], {
            env: { PATH: process.env.PATH!, LEDGER, STATES: PUBLICATION, ...env },
        }).toString()
    ) as Record<string, unknown>;

describe('the operation ledger script', () => {
    it('answers an operation it never saw with nothing', () => {
        expect(run(ledgerFile(), { ACTION: 'read', OP })).toEqual({});
    });

    it('records how far an operation got, and a later read answers it', () => {
        const file = ledgerFile();
        expect(run(file, { ACTION: 'write', OP, STATE: 'pushing' })).toMatchObject({ state: 'pushing' });
        run(file, { ACTION: 'write', OP, STATE: 'opened', DATA: '{"prUrl":"https://github.com/o/r/pull/7"}' });
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
            env: {
                PATH: process.env.PATH!,
                LEDGER: ledgerFile(),
                STATES: PUBLICATION,
                ACTION: 'write',
                OP,
                STATE: 'done',
            },
        });
        expect(result.status).toBe(1);
        expect(result.stderr.toString()).toMatch(/not a ledger write/);
    });

    it("takes each ledger's own states: a helper effect moves started → done with its result, never back", () => {
        const file = ledgerFile();
        const helper = { STATES: 'started,done', OP: 'effect-1' };
        run(file, { ...helper, ACTION: 'write', STATE: 'started' });
        run(file, { ...helper, ACTION: 'write', STATE: 'done', DATA: '{"result":{"ok":true,"output":"X"}}' });
        expect(run(file, { ...helper, ACTION: 'write', STATE: 'started' })).toMatchObject({ state: 'done' });
        expect(run(file, { ...helper, ACTION: 'read' })).toMatchObject({
            state: 'done',
            result: { ok: true, output: 'X' },
        });
    });

    it('refuses DATA that is not a JSON object, writing nothing', () => {
        const file = ledgerFile();
        const result = spawnSync('node', ['-e', SCRIPT], {
            env: {
                PATH: process.env.PATH!,
                LEDGER: file,
                STATES: PUBLICATION,
                ACTION: 'write',
                OP,
                STATE: 'pushed',
                DATA: '[1]',
            },
        });
        expect(result.status).toBe(1);
        expect(run(file, { ACTION: 'read', OP })).toEqual({});
    });
});
