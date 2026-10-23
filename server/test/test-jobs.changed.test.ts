import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MAP = join(ROOT, 'scripts/test-jobs-changed.mjs');
const SCRIPT = readFileSync(join(ROOT, 'scripts/test-jobs.sh'), 'utf8');

interface Decision {
    file: string;
    result: string | string[];
    reason: string;
    unmapped: boolean;
}
interface Verdict {
    selected: string | string[];
    decisions: Decision[];
}

// The CLI is the contract the lane uses, so the tests drive it, not a re-implementation of it.
function classify(files: string[]): Verdict {
    const out = spawnSync('node', [MAP, '--files', '--json'], { input: files.join('\n'), encoding: 'utf8' });
    expect(out.status).toBe(0);
    return JSON.parse(out.stdout) as Verdict;
}

function tracked(...dirs: string[]): string[] {
    return execFileSync('git', ['ls-files', ...dirs], { cwd: ROOT, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
}

// The phases test-jobs.sh accepts, read from its own validator so the two lists cannot drift.
function scriptPhases(): string[] {
    const body = /valid_phase\(\) \{\n {4}case "\$1" in\n {4}([^)]+)\) return 0/.exec(SCRIPT)?.[1];
    expect(body).toBeDefined();
    return (body ?? '').split('|');
}

describe('test-jobs --changed path-to-phase map', () => {
    const ranges = tracked('driver/src', 'docker', 'scripts');

    it('lists exactly the phases the script accepts, in the order it runs them', async () => {
        const { PHASES } = (await import(MAP)) as { PHASES: string[] };
        expect([...PHASES].sort()).toEqual([...scriptPhases()].sort());
        const order = PHASES.map((phase) => SCRIPT.indexOf(`selected_phase ${phase}; then\nbegin_phase ${phase}\n`));
        expect(order.every((at) => at > 0)).toBe(true);
        expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it('reaches every phase from some rule', async () => {
        const { PHASES, RULES } = (await import(MAP)) as { PHASES: string[]; RULES: [RegExp, unknown, string][] };
        const reached = new Set(RULES.flatMap(([, result]) => (Array.isArray(result) ? (result as string[]) : [])));
        expect(PHASES.filter((phase) => !reached.has(phase))).toEqual([]);
    });

    it('maps every tracked source path under driver/src, docker/ and scripts/ with a rule, not the fallback', () => {
        expect(ranges.length).toBeGreaterThan(100);
        const verdict = classify(ranges);
        expect(verdict.decisions.filter((decision) => decision.unmapped).map((decision) => decision.file)).toEqual([]);
    });

    it('keeps no rule that matches nothing tracked', async () => {
        const { RULES } = (await import(MAP)) as { RULES: [RegExp, unknown, string][] };
        const all = tracked();
        expect(
            RULES.filter(([pattern]) => !all.some((file) => pattern.test(file))).map(([pattern]) => String(pattern))
        ).toEqual([]);
    });

    it('sends the shared files to the full lane', () => {
        for (const file of [
            'scripts/test-jobs.sh',
            'scripts/stub-agent.sh',
            'scripts/stub-runner.Dockerfile',
            'scripts/test-jobs-changed.mjs',
            'docker/claude-executor/ctl-agent.cjs',
            'docker/claude-executor/factory-launch.sh',
            'driver/src/scripts/supervisor.cjs',
            'driver/src/runner.ts',
            'server/src/main.ts',
        ]) {
            expect(classify([file]).selected, file).toBe('full');
        }
    });

    it('falls back to the full lane on a path it does not know, and says so', () => {
        const verdict = classify(['driver/src/brand-new-module.ts']);
        expect(verdict.selected).toBe('full');
        expect(verdict.decisions[0]).toMatchObject({ unmapped: true, reason: 'unmapped path' });
    });

    it('maps a loop-adopt change to its recovery phases only, in lane order', () => {
        expect(classify(['driver/src/loop-adopt.ts', 'driver/test/loop-adopt.test.ts']).selected).toEqual([
            'node-disruption',
            'driver-kill',
        ]);
    });

    it('unions the phases of several files and ignores files no lane executes', () => {
        expect(
            classify(['driver/src/run-deadline.ts', 'driver/src/k8s-runner.ts', 'docs/jobs.md', 'web/src/App.tsx'])
                .selected
        ).toEqual(['run-deadline']);
    });

    it('selects nothing when only unexecuted files changed, and when nothing changed', () => {
        expect(classify(['docs/executor-testing.md', 'driver/src/k8s-gate.ts']).selected).toEqual([]);
        expect(classify([]).selected).toEqual([]);
    });

    it('prints the choice and why on stderr and the bare list on stdout', () => {
        const out = spawnSync('node', [MAP, '--files'], { input: 'driver/src/run-deadline.ts\n', encoding: 'utf8' });
        expect(out.stdout).toBe('run-deadline');
        expect(out.stderr).toContain('[changed] driver/src/run-deadline.ts -> run-deadline (run deadline)');
        expect(out.stderr).toContain('[changed] phases: run-deadline');
        const none = spawnSync('node', [MAP, '--files'], { input: '', encoding: 'utf8' });
        expect(none.stdout).toBe('');
        expect(none.stderr).toContain('no changed files');
    });
});
