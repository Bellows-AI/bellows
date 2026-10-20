import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts/test-jobs.sh');
const directories: string[] = [];
// A hang guard, not a speed bound: the script settles in about a second of CPU and in 4-7s under
// heavy host load, so a tight kill reads as a failure (status null) in a loaded `npm test`.
const HANG_GUARD_MS = 120_000;

const COMMANDS = {
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
        image=''
        for arg do
            case "$arg" in claude-executor|opencode-executor) image="$arg" ;; esac
        done
        if [ "$EXPECT_PAIR" = 1 ]; then
            touch "$HARNESS_GATE/$image.started"
            attempts=0
            while ! { [ -f "$HARNESS_GATE/claude-executor.started" ] && [ -f "$HARNESS_GATE/opencode-executor.started" ]; }; do
                attempts=$((attempts + 1))
                [ "$attempts" -lt 6000 ] || exit 99
                sleep 0.01
            done
        fi
        if [ -n "$ABORT_WORKER" ] && [ "$ABORT_WORKER" = "$image" ]; then
            kill -KILL "$PPID"
            exit 0
        fi
        for arg do
            case "$arg" in *:/workspace) touch "\${arg%:/workspace}/step-1" ;; esac
        done
        ;;
    'wait '*) printf '%s\n' "\${SUPERVISOR_EXIT:-0}" ;;
    'logs '*) echo 'supervisor diagnostics' ;;
esac
exit 0`,
    node: `case "$1" in
    scripts/fake-model-endpoint.mjs) printf '1234\n' ;;
    -e) printf '1\n' ;;
    *) exit 99 ;;
esac`,
    npm: 'echo unexpected-npm >>"$HARNESS_TRACE"; exit 99',
    timeout: `shift
if [ "$1" = docker ] && [ "$2" = wait ]; then
    [ -z "$SUPERVISOR_WAIT_STATUS" ] || exit "$SUPERVISOR_WAIT_STATUS"
else
    [ "$AGENT_TIMEOUT" != 1 ] || exit 124
fi
exec "$@"`,
};

// Exercise routing, preflight and artifact handling through the real shell script. These tools
// emulate only the standalone Stop lane's boundaries; the live lane still proves the agent behavior.
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'jobs-options-'));
    directories.push(dir);
    const trace = join(dir, 'commands');
    const timings = join(dir, 'timings.tsv');
    writeFileSync(trace, '');
    for (const [name, body] of Object.entries(COMMANDS)) {
        writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    }
    return {
        // Async on purpose: a blocking spawn stops the vitest worker answering its RPC channel, and
        // under load the runner reports `Timeout calling "onTaskUpdate"` for a test that passed.
        run: (args: string[], env: NodeJS.ProcessEnv = {}) =>
            new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
                const child = spawn('/bin/bash', [SCRIPT, ...args], {
                    cwd: ROOT,
                    env: {
                        ...process.env,
                        PATH: `${dir}:${process.env.PATH}`,
                        HARNESS_TRACE: trace,
                        HARNESS_GATE: dir,
                        TIMINGS_FILE: timings,
                        AGENT_TIMEOUT: '',
                        POSTGRES_START_FAIL: '',
                        SUPERVISOR_WAIT_STATUS: '',
                        SUPERVISOR_EXIT: '0',
                        EXPECT_PAIR: '',
                        ABORT_WORKER: '',
                        ...env,
                    },
                    timeout: HANG_GUARD_MS,
                });
                let stdout = '';
                let stderr = '';
                child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
                child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
                child.on('close', (status) => resolve({ status, stdout, stderr }));
            }),
        trace: () => readFileSync(trace, 'utf8'),
        timings: () => readFileSync(timings, 'utf8'),
        checks: () => readFileSync(join(dir, 'timings.checks.tsv'), 'utf8'),
        lifecycle: () => readFileSync(join(dir, 'timings.lifecycle.tsv'), 'utf8'),
        log: (name: string) => readFileSync(join(dir, `timings.${name}.log`), 'utf8'),
    };
}

afterEach(() => {
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('test-jobs phase options', () => {
    it('offers help without accessing Docker or creating lane resources', async () => {
        const lane = fixture();
        const result = await lane.run(['--help']);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('all (default)');
        expect(result.stdout).toContain('question-round-trip');
        expect(result.stdout).toContain('run-deadline');
        expect(result.stdout).toContain('run-deadline, review,');
        expect(lane.trace()).toBe('');
    });

    it.each([
        ['--phase'],
        ['--phase', 'unknown'],
        ['--unknown'],
        ['--cli-workers'],
        ['--cli-workers', '0'],
        ['--cli-workers', '3'],
    ])('rejects invalid arguments %j', async (...args) => {
        const lane = fixture();
        expect((await lane.run(args)).status).toBe(2);
        expect(lane.trace()).toBe('');
    });

    it('checks both real executor images before any full-run setup or cleanup', async () => {
        const lane = fixture();
        const result = await lane.run([], { MISSING_IMAGE: 'opencode-executor' });
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('opencode-executor is missing');
        expect(lane.trace().trim().split('\n')).toEqual([
            'info',
            'image inspect claude-executor',
            'image inspect opencode-executor',
        ]);
    });

    it('requires only Claude for the question round trip and stops before board setup if absent', async () => {
        const lane = fixture();
        const result = await lane.run(['--phase', 'question-round-trip'], { MISSING_IMAGE: 'claude-executor' });
        expect(result.status).toBe(1);
        expect(lane.trace().trim().split('\n')).toEqual(['info', 'image inspect claude-executor']);
    });

    it('refuses an unsafe database before touching Postgres, without requiring real executor images', async () => {
        const lane = fixture();
        const result = await lane.run(['--phase', 'board'], { JOBS_TEST_DB: 'factory_dev' });
        expect(result.status).toBe(2);
        expect(result.stdout).toContain('ending _test');
        expect(lane.trace().trim().split('\n')).toEqual(['info', 'compose version']);
    });

    it.each(['1', '2'])('runs every standalone CLI check with %s workers and no board setup', async (workers) => {
        const lane = fixture();
        const result = await lane.run(['--phase', 'cooperative-stop', '--cli-workers', workers]);
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('8 passed, 0 failed');
        expect(lane.trace()).not.toMatch(/compose|unexpected-npm|factory-jobs-smoke/);
        expect(lane.timings()).toMatch(/^cooperative-stop\t\d+$/m);
        expect(lane.timings()).toMatch(/^cleanup\t\d+$/m);
        expect(lane.timings()).toMatch(/^total\t\d+$/m);
        expect(lane.checks().trim().split('\n')).toHaveLength(9);
        expect(lane.lifecycle()).toMatch(/^cooperative-stop\tstop-opencode\tagent\t\d+\t0$/m);
        expect(lane.lifecycle()).toMatch(/^cooperative-stop\tstop-opencode\tsupervisor-wait\t\d+\t0$/m);
        expect(lane.lifecycle()).toMatch(/^cooperative-stop\tstop-opencode\tcleanup\t\d+\t0$/m);
        expect(lane.log('stop-claude')).toBe('');
    });

    it('starts both CLI workers before either agent is allowed to finish', async () => {
        const lane = fixture();
        const result = await lane.run(['--phase', 'cooperative-stop'], { EXPECT_PAIR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('8 passed, 0 failed');
    });

    it('fails an abruptly lost worker and cleans its resources without losing the other worker results', async () => {
        const lane = fixture();
        const result = await lane.run(['--phase', 'cooperative-stop'], { ABORT_WORKER: 'claude-executor' });
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('claude_stop_lane reports its checks');
        expect(result.stdout).toContain('opencode exits on its own after the stop');
        expect(lane.trace()).toMatch(/rm -f lane-agent-.*stop-claude lane-sup-.*stop-claude/);
        expect(lane.checks()).toContain('\tFAIL\t');
    });

    it('does not recreate shared Postgres and preserves startup errors before any build', async () => {
        const lane = fixture();
        const result = await lane.run(['--phase', 'board'], { POSTGRES_START_FAIL: '1' });
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('could not start postgres');
        expect(lane.trace()).toContain('compose up -d --no-recreate postgres');
        expect(lane.trace()).not.toContain('unexpected-npm');
        expect(lane.log('postgres')).toContain('simulated postgres startup failure');
        expect(lane.timings()).toMatch(/^postgres\t\d+$/m);
        expect(lane.timings()).toMatch(/^cleanup\t\d+$/m);
    });

    it('gives separate runs distinct disposable databases and image cleanup targets', async () => {
        const traces: string[] = [];
        for (const lane of [fixture(), fixture()]) {
            expect((await lane.run(['--phase', 'board'], { JOBS_TEST_DB: '' })).status).toBe(1);
            traces.push(lane.trace());
        }
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

    it('retains failure status, check results, timings and logs through cleanup', async () => {
        const lane = fixture();
        const result = await lane.run(['--phase', 'cooperative-stop'], { AGENT_TIMEOUT: '1' });
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('exit 124');
        expect(result.stdout).toContain('exit: 1');
        expect(lane.timings()).toMatch(/^cleanup\t\d+$/m);
        expect(lane.timings()).toMatch(/^total\t\d+$/m);
        expect(lane.checks()).toContain('\tFAIL\t');
        expect(lane.log('stop-opencode')).toBe('');
    });

    it.each(['124', '125'])(
        'fails a supervisor wait with status %s after collecting diagnostics and cleaning up',
        async (status) => {
            const lane = fixture();
            const result = await lane.run(['--phase', 'cooperative-stop'], { SUPERVISOR_WAIT_STATUS: status });
            expect(result.status).toBe(1);
            expect(result.stdout).toContain(`wait exit ${status}`);
            expect(lane.log('stop-opencode.supervisor')).toContain('supervisor diagnostics');
            expect(lane.lifecycle()).toMatch(new RegExp(`\\tsupervisor-wait\\t\\d+\\t${status}`));
            expect(lane.trace()).toMatch(/rm -f lane-agent-.* lane-sup-/);
            expect(lane.trace()).toMatch(/volume rm -f lane-/);
        }
    );

    it('fails a nonzero supervisor verdict even when docker wait itself succeeds', async () => {
        const lane = fixture();
        const result = await lane.run(['--phase', 'cooperative-stop'], { SUPERVISOR_EXIT: '70' });
        expect(result.status).toBe(1);
        expect(result.stdout).toContain("supervisor exit '70'");
        expect(lane.log('stop-opencode.supervisor-wait')).toBe('70\n');
        expect(lane.trace()).toMatch(/rm -f lane-agent-.* lane-sup-/);
    });
});
