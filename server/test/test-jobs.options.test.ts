import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts/test-jobs.sh');
const directories: string[] = [];

// Exercise routing, preflight and artifact handling through the real shell script. These tools
// emulate only the standalone Stop lane's boundaries; the live lane still proves the agent behavior.
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'jobs-options-'));
    directories.push(dir);
    const trace = join(dir, 'commands');
    const timings = join(dir, 'timings.tsv');
    writeFileSync(trace, '');
    const commands = {
        docker: `printf '%s\n' "$*" >>"$HARNESS_TRACE"
case "$1 $2" in
    'image inspect') [ "$3" != "\${MISSING_IMAGE:-}" ] || exit 1 ;;
    'compose up')
        if [ "$POSTGRES_START_FAIL" = 1 ]; then
            echo 'simulated postgres startup failure' >&2
            exit 1
        fi
        ;;
    'run --rm')
        for arg do
            case "$arg" in *:/workspace) touch "\${arg%:/workspace}/step-1" ;; esac
        done
        ;;
esac
exit 0`,
        node: `case "$1" in
    scripts/fake-model-endpoint.mjs) printf '1234\n' ;;
    -e) printf '1\n' ;;
    *) exit 99 ;;
esac`,
        npm: 'echo unexpected-npm >>"$HARNESS_TRACE"; exit 99',
        timeout: '[ "$AGENT_TIMEOUT" != 1 ] || exit 124; shift; exec "$@"',
    };
    for (const [name, body] of Object.entries(commands)) {
        writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    }
    return {
        run: (args: string[], env: NodeJS.ProcessEnv = {}) =>
            spawnSync('/bin/bash', [SCRIPT, ...args], {
                cwd: ROOT,
                env: {
                    ...process.env,
                    PATH: `${dir}:${process.env.PATH}`,
                    HARNESS_TRACE: trace,
                    TIMINGS_FILE: timings,
                    AGENT_TIMEOUT: '',
                    POSTGRES_START_FAIL: '',
                    ...env,
                },
                encoding: 'utf8',
                timeout: 10_000,
            }),
        trace: () => readFileSync(trace, 'utf8'),
        timings: () => readFileSync(timings, 'utf8'),
        checks: () => readFileSync(join(dir, 'timings.checks.tsv'), 'utf8'),
        log: (name: string) => readFileSync(join(dir, `timings.${name}.log`), 'utf8'),
    };
}

afterEach(() => {
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('test-jobs phase options', () => {
    it('offers help without accessing Docker or creating lane resources', () => {
        const lane = fixture();
        const result = lane.run(['--help']);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('all (default)');
        expect(result.stdout).toContain('question-round-trip');
        expect(lane.trace()).toBe('');
    });

    it.each([['--phase'], ['--phase', 'unknown'], ['--unknown']])('rejects invalid arguments %j', (...args) => {
        const lane = fixture();
        expect(lane.run(args).status).toBe(2);
        expect(lane.trace()).toBe('');
    });

    it('checks both real executor images before any full-run setup or cleanup', () => {
        const lane = fixture();
        const result = lane.run([], { MISSING_IMAGE: 'opencode-executor' });
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('opencode-executor is missing');
        expect(lane.trace().trim().split('\n')).toEqual([
            'info',
            'image inspect claude-executor',
            'image inspect opencode-executor',
        ]);
    });

    it('requires only Claude for the question round trip and stops before board setup if absent', () => {
        const lane = fixture();
        const result = lane.run(['--phase', 'question-round-trip'], { MISSING_IMAGE: 'claude-executor' });
        expect(result.status).toBe(1);
        expect(lane.trace().trim().split('\n')).toEqual(['info', 'image inspect claude-executor']);
    });

    it('refuses an unsafe database before touching Postgres, without requiring real executor images', () => {
        const lane = fixture();
        const result = lane.run(['--phase', 'board'], { JOBS_TEST_DB: 'factory_dev' });
        expect(result.status).toBe(2);
        expect(result.stdout).toContain('ending _test');
        expect(lane.trace().trim().split('\n')).toEqual(['info', 'compose version']);
    });

    it('runs standalone CLI checks with no database, build, board phases or board cleanup', () => {
        const lane = fixture();
        const result = lane.run(['--phase', 'cooperative-stop']);
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('6 passed, 0 failed');
        expect(lane.trace()).not.toMatch(/compose|unexpected-npm|factory-jobs-smoke/);
        expect(lane.timings()).toMatch(/^cooperative-stop\t\d+$/m);
        expect(lane.timings()).toMatch(/^cleanup\t\d+$/m);
        expect(lane.timings()).toMatch(/^total\t\d+$/m);
        expect(lane.checks().trim().split('\n')).toHaveLength(7);
        expect(lane.log('stop-claude')).toBe('');
    });

    it('does not recreate shared Postgres and preserves startup errors before any build', () => {
        const lane = fixture();
        const result = lane.run(['--phase', 'board'], { POSTGRES_START_FAIL: '1' });
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('could not start postgres');
        expect(lane.trace()).toContain('compose up -d --no-recreate postgres');
        expect(lane.trace()).not.toContain('unexpected-npm');
        expect(lane.log('postgres')).toContain('simulated postgres startup failure');
        expect(lane.timings()).toMatch(/^postgres\t\d+$/m);
        expect(lane.timings()).toMatch(/^cleanup\t\d+$/m);
    });

    it('gives separate runs distinct disposable databases and image cleanup targets', () => {
        const traces = [fixture(), fixture()].map((lane) => {
            expect(lane.run(['--phase', 'board'], { JOBS_TEST_DB: '' }).status).toBe(1);
            return lane.trace();
        });
        const databases = traces.map((trace) => /create database (factory_jobs_\w+_test)/.exec(trace)?.[1]);
        expect(databases[0]).toBeTruthy();
        expect(databases[1]).toBeTruthy();
        expect(databases[0]).not.toBe(databases[1]);
        for (const [index, trace] of traces.entries()) {
            expect(trace).toContain(`drop database if exists ${databases[index]}`);
        }
        const images = traces.map((trace) => /image rm -f (\S+)/.exec(trace)?.[1]);
        expect(images[0]).toBeTruthy();
        expect(images[1]).toBeTruthy();
        expect(images[0]).not.toBe(images[1]);
    });

    it('retains failure status, check results, timings and logs through cleanup', () => {
        const lane = fixture();
        const result = lane.run(['--phase', 'cooperative-stop'], { AGENT_TIMEOUT: '1' });
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('exit 124');
        expect(result.stdout).toContain('exit: 1');
        expect(lane.timings()).toMatch(/^cleanup\t\d+$/m);
        expect(lane.timings()).toMatch(/^total\t\d+$/m);
        expect(lane.checks()).toContain('\tFAIL\t');
        expect(lane.log('stop-opencode')).toBe('');
    });
});
