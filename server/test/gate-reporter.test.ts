import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

interface Reporter {
    onInit(ctx: unknown): void;
    onTestModuleStart(module: unknown): void;
    onTestModuleEnd(module: unknown): void;
    onTestCaseResult(testCase: unknown): void;
    onTestRunEnd(): void;
}
const SCRIPTS = new URL('../../scripts/', import.meta.url).href;
const { default: GateReporter, TestsSection } = (await import(/* @vite-ignore */ `${SCRIPTS}gate-reporter.mjs`)) as {
    default: new (options?: unknown) => Reporter;
    TestsSection: new (options?: unknown) => { started(file: string): void };
};
const { readSection, writeSection } = (await import(/* @vite-ignore */ `${SCRIPTS}gate-report.mjs`)) as {
    readSection: (section: string, env?: Record<string, string>) => unknown;
    writeSection: (section: string, data: unknown, env?: Record<string, string>) => void;
};

/**
 * The gate's report mailbox (`$FACTORY_GATE_RUN/report`) and the vitest reporter that fills its `tests` section.
 * The reporter is driven with the objects vitest hands it; scripts/gate-reporter.mjs is what the gates name.
 */
const dirs: string[] = [];
const gateRun = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-report-'));
    dirs.push(dir);
    return dir;
};
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tests = (run: string) => JSON.parse(readFileSync(join(run, 'report', 'tests.json'), 'utf8'));

describe('the gate report mailbox', () => {
    it('writes a section whole and reads it back; outside a gate it does nothing', () => {
        const run = gateRun();
        writeSection('selection', { mode: 'all' }, { FACTORY_GATE_RUN: run });
        expect(readSection('selection', { FACTORY_GATE_RUN: run })).toEqual({ mode: 'all' });
        writeSection('selection', { mode: 'x' }, {});
        expect(readSection('selection', {})).toBeNull();
    });
});

describe('the gate vitest reporter', () => {
    const module = (id: string, ms = 0) => ({ moduleId: `/repo/${id}`, diagnostic: () => ({ duration: ms }) });
    const make = (run: string) => {
        const env = { FACTORY_GATE_RUN: run };
        let t = 0;
        const reporter = new GateReporter({
            write: (s: string, d: unknown) => writeSection(s, d, env),
            read: (s: string) => readSection(s, env),
            now: () => (t += 2000),
        });
        reporter.onInit({ config: { root: '/repo' } });
        return reporter;
    };

    it('records the failures and durations as they come, and the files still running', () => {
        const run = gateRun();
        const reporter = make(run);
        reporter.onTestModuleStart(module('core/test/a.test.ts'));
        reporter.onTestModuleStart(module('core/test/b.test.ts'));
        reporter.onTestCaseResult({
            module: module('core/test/a.test.ts'),
            fullName: 'adds > two numbers',
            result: () => ({ state: 'failed', errors: [{ message: 'expected 3 to be 4' }] }),
        });
        reporter.onTestCaseResult({
            module: module('core/test/a.test.ts'),
            fullName: 'ok',
            result: () => ({ state: 'passed' }),
        });
        // Killed here: what the file holds is what the gate's answer carries.
        expect(tests(run)).toMatchObject({
            failures: [{ file: 'core/test/a.test.ts', test: 'adds > two numbers', message: 'expected 3 to be 4' }],
            inFlight: ['core/test/a.test.ts', 'core/test/b.test.ts'],
        });
        reporter.onTestModuleEnd(module('core/test/a.test.ts', 1234.6));
        reporter.onTestRunEnd();
        expect(tests(run)).toMatchObject({
            files: [{ file: 'core/test/a.test.ts', ms: 1235 }],
            inFlight: ['core/test/b.test.ts'],
        });
    });

    it('bounds what it writes: an 85 KiB assertion message still yields the failure, truncated, and the files in flight', () => {
        const run = gateRun();
        const reporter = make(run);
        reporter.onTestModuleStart(module('core/test/slow.test.ts'));
        for (let i = 0; i < 80; i += 1) {
            reporter.onTestCaseResult({
                module: module(`core/test/f${i}.test.ts`),
                fullName: `case ${i}`,
                result: () => ({ state: 'failed', errors: [{ message: 'x'.repeat(i === 0 ? 85 * 1024 : 5000) }] }),
            });
        }
        for (let i = 0; i < 300; i += 1) reporter.onTestModuleEnd(module(`core/test/d${i}.test.ts`, i));
        reporter.onTestRunEnd();
        const file = readFileSync(join(run, 'report', 'tests.json'), 'utf8');
        expect(file.length).toBeLessThan(65_536);
        const section = JSON.parse(file);
        expect(section.failures[0].file).toBe('core/test/f0.test.ts');
        expect(section.failures[0].message.length).toBeGreaterThan(0);
        expect(section.failures[0].message.length).toBeLessThan(5000);
        expect(section.failureCount).toBe(80);
        expect(section.inFlight).toEqual(['core/test/slow.test.ts']);
        expect(section.files.length).toBeLessThanOrEqual(50);
        expect(section.files[0].ms).toBe(299);
    });

    it('accumulates over the several vitest runs of one gate', () => {
        const run = gateRun();
        const first = make(run);
        first.onTestModuleStart(module('a.test.ts'));
        first.onTestModuleEnd(module('a.test.ts', 10));
        first.onTestRunEnd();
        const second = make(run);
        second.onTestModuleStart(module('b.test.ts'));
        second.onTestModuleEnd(module('b.test.ts', 20));
        second.onTestRunEnd();
        expect(
            tests(run)
                .files.map((f: { file: string }) => f.file)
                .sort()
        ).toEqual(['a.test.ts', 'b.test.ts']);
    });

    it('spaces the writes of an unfinished run', () => {
        const writes: string[] = [];
        let t = 0;
        const section = new TestsSection({
            write: (s: string) => writes.push(s),
            read: () => null,
            now: () => (t += 100),
        });
        for (let i = 0; i < 5; i += 1) section.started(`f${i}.test.ts`);
        expect(writes.length).toBe(1);
    });
});
