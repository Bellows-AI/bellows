import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { gateReporters } from '../../vitest.gate-reporters.js';

/**
 * Every vitest gate records its structured result, with no wiring in the gate's command: the shared
 * `vitest.gate-reporters.ts` is spread into the root and db configs (the executors config extends the root), so
 * `test`, `test:executors` and `test:db` are covered, and a new vitest gate is too. Spawns a real vitest.
 */
const ROOT = new URL('../../', import.meta.url).pathname;
const dirs: string[] = [];
afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('the gate reporter in the vitest configs', () => {
    it('adds the reporter beside the default one inside a gate only', () => {
        expect(gateReporters({})).toEqual({});
        const inGate = gateReporters({ FACTORY_GATE_RUN: '/factory/gate/running/x' });
        expect(inGate.reporters?.[0]).toBe('default');
        expect(inGate.reporters?.[1]).toMatch(/scripts\/gate-reporter\.mjs$/);
    });

    it('is spread into every config a gate runs vitest with', () => {
        for (const config of ['vitest.config.ts', 'vitest.db.config.ts']) {
            expect(readFileSync(join(ROOT, config), 'utf8'), config).toContain('...gateReporters()');
        }
        expect(readFileSync(join(ROOT, 'vitest.executors.config.ts'), 'utf8')).toContain('...root.test');
    });

    it('makes the test:executors command write its structured result', () => {
        const run = mkdtempSync(join(tmpdir(), 'gate-run-'));
        dirs.push(run);
        const executors = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts[
            'test:executors'
        ] as string;
        expect(executors.startsWith('vitest run ')).toBe(true);
        const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', FACTORY_GATE_RUN: run };
        const done = spawnSync(
            'npx',
            ['vitest', 'run', '--config', 'vitest.executors.config.ts', 'driver/test/gate-result.test.ts'],
            {
                cwd: ROOT,
                env,
                encoding: 'utf8',
                timeout: 120_000,
            }
        );
        expect(done.status, done.stdout + done.stderr).toBe(0);
        const section = JSON.parse(readFileSync(join(run, 'report', 'tests.json'), 'utf8'));
        expect(section.files.map((f: { file: string }) => f.file)).toContain('driver/test/gate-result.test.ts');
        expect(section.inFlight).toEqual([]);
    });
});
