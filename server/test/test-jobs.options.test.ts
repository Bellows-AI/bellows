import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

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
    # The daemon kind and the default bridge's gateway: $DOCKER_OS empty fails the read, as does an empty gateway.
    'info --format') [ -n "\${DOCKER_OS-Docker Desktop}" ] || exit 1; printf '%s\n' "\${DOCKER_OS-Docker Desktop}" ;;
    'network inspect') [ -n "\${BRIDGE_GATEWAY:-}" ] || exit 1; printf '%s\n' "$BRIDGE_GATEWAY" ;;
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
            # A rendezvous on two FIFOs: claude's write returns only once opencode has started and read it,
            # opencode's write only once claude has reached its read. The 60s watchdog is a hang bound
            # (stdio detached so it never holds the script's pipes open), not a speed bound.
            ( sleep 60; kill -TERM "$$" ) >/dev/null 2>&1 &
            watchdog=$!
            if [ "$image" = claude-executor ]; then
                echo started >"$HARNESS_GATE/claude.fifo"
                read -r _ <"$HARNESS_GATE/opencode.fifo"
            else
                read -r _ <"$HARNESS_GATE/claude.fifo"
                echo started >"$HARNESS_GATE/opencode.fifo"
            fi
            kill "$watchdog" 2>/dev/null
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
    // --changed maps real git output through the real map; git answers with $CHANGED_FILES.
    git: `case "$1" in
    merge-base) echo deadbeef ;;
    diff) printf '%s' "$CHANGED_FILES" ;;
    ls-files) ;;
    *) exit 99 ;;
esac`,
    node: `case "$1" in
    */scripts/test-jobs-changed.mjs | */scripts/test-jobs-groups.mjs) exec "$REAL_NODE" "$@" ;;
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
                if (env.EXPECT_PAIR === '1') {
                    for (const name of ['claude', 'opencode']) execFileSync('mkfifo', [join(dir, `${name}.fifo`)]);
                }
                const child = spawn('/bin/bash', [SCRIPT, ...args], {
                    cwd: ROOT,
                    env: {
                        ...process.env,
                        PATH: `${dir}:${process.env.PATH}`,
                        HARNESS_TRACE: trace,
                        HARNESS_GATE: dir,
                        REAL_NODE: process.execPath,
                        CHANGED_FILES: '',
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
        expect(result.stdout).toContain('acceptance');
        expect(lane.trace()).toBe('');
    });

    // Issue #829: a stall watcher is opt-in, by flag or by environment, and never reaches docker for --help.
    it('lists --watch-stalls with its threshold and leaves docker alone when asked for help', async () => {
        const lane = fixture();
        const help = await lane.run(['--help']);
        expect(help.stdout).toContain('--watch-stalls');
        expect(help.stdout).toContain('LANE_WATCH_STALLS=1');
        expect(help.stdout).toContain('LANE_STALL_S');
        expect(lane.trace()).toBe('');
    });

    // Issue #829: the phase that kills a real driver at each step of a run.
    it('lists the driver-kill phase in --help', async () => {
        const help = await fixture().run(['--help']);
        expect(help.stdout).toContain('driver-kill');
    });

    it('accepts driver-kill as a phase', async () => {
        const result = await fixture().run(['--phase', 'driver-kill'], { JOBS_TEST_DB: 'factory_dev' });
        expect(result.status).toBe(2);
        expect(result.stdout).toContain('ending _test');
        expect(result.stdout).not.toContain('invalid --phase');
    });

    // Issue #831: competing drivers under one shared admission budget.
    it('lists the capacity phase in --help', async () => {
        const help = await fixture().run(['--help']);
        expect(help.stdout).toContain('capacity');
    });

    it('accepts capacity as a phase', async () => {
        const result = await fixture().run(['--phase', 'capacity'], { JOBS_TEST_DB: 'factory_dev' });
        expect(result.status).toBe(2);
        expect(result.stdout).toContain('ending _test');
        expect(result.stdout).not.toContain('invalid --phase');
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
        const lanes = [fixture(), fixture()];
        // Concurrent: the two runs share nothing, and the ids must differ even when started together.
        const results = await Promise.all(lanes.map((lane) => lane.run(['--phase', 'board'], { JOBS_TEST_DB: '' })));
        for (const result of results) expect(result.status).toBe(1);
        const traces = lanes.map((lane) => lane.trace());
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
    // Issue #950: phases that share one board fixture are named as a comma list.
    it.each(['board,driver', 'driver-kill,capacity,services', 'services,node-disruption', 'board,board'])(
        'accepts the comma list %j of phases',
        async (list) => {
            const result = await fixture().run(['--phase', list], { JOBS_TEST_DB: 'factory_dev' });
            expect(result.status, list).toBe(2);
            expect(result.stdout, list).toContain('ending _test');
        }
    );

    it.each(['board,bogus', 'board,,driver', 'board,', ',board', 'all,board'])(
        'rejects the unknown, empty or mixed-in list %j',
        async (list) => {
            const result = await fixture().run(['--phase', list]);
            expect(result.status, list).toBe(2);
            expect(result.stdout, list).toContain('invalid --phase');
        }
    );

    it('requires the real executor images a listed standalone phase needs, before any board setup', async () => {
        const lane = fixture();
        const result = await lane.run(['--phase', 'ask-user-question,cooperative-stop'], {
            MISSING_IMAGE: 'opencode-executor',
        });
        expect(result.status).toBe(1);
        expect(lane.trace().trim().split('\n')).toEqual([
            'info',
            'image inspect claude-executor',
            'image inspect opencode-executor',
        ]);
    });

    it('boots no board for a list of standalone phases', async () => {
        const alone = await fixture().run(['--phase', 'ask-user-question,cooperative-stop'], {
            JOBS_TEST_DB: 'factory_dev',
        });
        expect(alone.stdout).not.toContain('ending _test');
    });

    it('boots a board for a list that mixes in a board phase', async () => {
        const mixed = await fixture().run(['--phase', 'tool-isolation,auth'], { JOBS_TEST_DB: 'factory_dev' });
        expect(mixed.status).toBe(2);
        expect(mixed.stdout).toContain('ending _test');
    });

    // Issue #950: --changed runs the phases mapped from the diff, says why, and runs nothing for none.
    it('runs nothing, and says so, when no file changed', async () => {
        const lane = fixture();
        const result = await lane.run(['--changed', 'origin/main']);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('no phase; nothing to run');
        expect(result.stderr).toContain('no changed files');
        expect(lane.trace()).toBe('');
    });

    it('runs nothing when only files no lane executes changed', async () => {
        const lane = fixture();
        const result = await lane.run(['--changed', 'origin/main'], {
            CHANGED_FILES: 'docs/jobs.md\ndriver/src/k8s/k8s-gate.ts\n',
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('nothing to run');
        expect(lane.trace()).toBe('');
    });

    it('selects the mapped phases and prints the reason for each file', async () => {
        const lane = fixture();
        const result = await lane.run(['--changed', 'origin/main'], {
            CHANGED_FILES: 'driver/src/loop/loop-adopt.ts\n',
            JOBS_TEST_DB: 'factory_dev',
        });
        expect(result.stdout).toContain('--changed origin/main runs: node-disruption,driver-kill');
        expect(result.stderr).toContain(
            '[changed] driver/src/loop/loop-adopt.ts -> node-disruption,driver-kill (adoption and takeover)'
        );
        expect(result.status).toBe(2);
        expect(result.stdout).toContain('ending _test');
    });

    it('falls back to the whole lane for a shared file', async () => {
        const lane = fixture();
        const result = await lane.run(['--changed', 'origin/main'], {
            CHANGED_FILES: 'scripts/stub-agent.sh\n',
            MISSING_IMAGE: 'claude-executor',
        });
        expect(result.stdout).toContain('runs: all');
        expect(result.stderr).toContain('full lane');
        expect(lane.trace().trim().split('\n')).toEqual(['info', 'image inspect claude-executor']);
    });

    it('refuses --changed together with --phase', async () => {
        const both = await fixture().run(['--changed', 'origin/main', '--phase', 'board']);
        expect(both.status).toBe(2);
        expect(both.stdout).toContain('exclusive');
    });

    it('refuses --changed without a base', async () => {
        const bare = await fixture().run(['--changed']);
        expect(bare.status).toBe(2);
        expect(bare.stdout).toContain('needs a base ref');
    });

    // Issue #887: --parallel fans the selected phases out as groups; serial stays the default.
    it('documents --parallel and --slots in --help', async () => {
        const help = await fixture().run(['--help']);
        expect(help.stdout).toContain('--parallel [--slots 2|3|4]');
    });

    it('refuses a slot count outside 2-4', async () => {
        const bad = await fixture().run(['--parallel', '--slots', '5']);
        expect(bad.status).toBe(2);
        expect(bad.stdout).toContain('--slots must be 2, 3 or 4');
    });

    it('refuses --parallel with one fixed database, which every group would share', async () => {
        const lane = fixture();
        const result = await lane.run(['--parallel', '--phase', 'cooperative-stop'], {
            JOBS_TEST_DB: 'factory_x_test',
        });
        expect(result.status).toBe(2);
        expect(result.stdout).toContain('unset JOBS_TEST_DB');
    });

    it('runs a group per slot as its own test-jobs run, with the sums of the groups in one summary', async () => {
        const lane = fixture();
        const result = await lane.run(['--parallel', '--phase', 'cooperative-stop']);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('[parallel] slot 0 (PORT 8129): cli-stop = cooperative-stop');
        expect(result.stdout).toMatch(/\[parallel\] cli-stop: exit 0 in \d+s \(cooperative-stop\)/);
        expect(result.stdout).toContain('8 passed, 0 failed');
        expect(lane.trace()).not.toMatch(/compose|unexpected-npm/);
    });

    it('fails when a group fails, and shows the failed checks', async () => {
        const lane = fixture();
        const result = await lane.run(['--parallel', '--phase', 'cooperative-stop'], { AGENT_TIMEOUT: '1' });
        expect(result.status).toBe(1);
        expect(result.stdout).toMatch(/\[parallel\] cli-stop: exit 1/);
        expect(result.stdout).toContain('FAIL ');
    });

    it('documents both flags and the policy in --help', async () => {
        const help = await fixture().run(['--help']);
        expect(help.stdout).toContain('--phase driver,services');
        expect(help.stdout).toContain('--changed BASE');
        expect(help.stdout).toContain('the full lane');
    });
});

// The boards and host drivers the lane's containers dial through host.docker.internal bind the
// address that name reaches. driver/test/lane-stubs.test.ts pins that every launch site uses it.
describe('test-jobs host bind', () => {
    it('binds the boards and host drivers to the bridge gateway on a native Linux daemon', async () => {
        const lane = fixture();
        const result = await lane.run(['--phase', 'driver'], {
            DOCKER_OS: 'Ubuntu 24.04 LTS',
            BRIDGE_GATEWAY: '172.17.0.1',
        });
        expect(result.stdout).toContain('test-jobs: boards and host drivers bind 172.17.0.1');
        expect(lane.trace()).toContain('network inspect bridge');
    });

    it('keeps them on 127.0.0.1 on Docker Desktop, without reading the bridge', async () => {
        const lane = fixture();
        const result = await lane.run(['--phase', 'driver'], { DOCKER_OS: 'Docker Desktop' });
        expect(result.stdout).toContain('test-jobs: boards and host drivers bind 127.0.0.1');
        expect(lane.trace()).not.toContain('network inspect');
    });

    it.each([
        ['a failed docker info read', { DOCKER_OS: '' }],
        ['a failed gateway read', { DOCKER_OS: 'Ubuntu 24.04 LTS', BRIDGE_GATEWAY: '' }],
        ['a malformed gateway', { DOCKER_OS: 'Ubuntu 24.04 LTS', BRIDGE_GATEWAY: '<no value>' }],
    ])('refuses the lane on %s, before any board starts, and never guesses loopback', async (_case, env) => {
        const lane = fixture();
        const result = await lane.run(['--phase', 'driver'], env);
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('test-jobs: cannot tell which address host.docker.internal reaches');
        expect(result.stdout).not.toContain('bind 127.0.0.1');
        expect(lane.trace()).not.toContain('compose up');
        expect(lane.trace()).not.toContain('unexpected-npm');
    });

    it('reads nothing for the standalone CLI phases, which start no board and no host driver', async () => {
        const lane = fixture();
        await lane.run(['--phase', 'cooperative-stop'], { DOCKER_OS: '' });
        expect(lane.trace()).not.toContain('info --format');
    });
});

// A board moved off loopback meets the server's off-loopback rules (an authenticated board needs PUBLIC_URL,
// MCP refuses an http one). Each board launch the lane runs is evaluated by bash under both resolved hosts,
// and the environment it would hand server/dist/offline*.js goes through the real config loader.
describe('test-jobs board launches boot config-valid', () => {
    // The lane in run order: each sourced phase file in place of its `. "$REPO/scripts/lanes/…"` line.
    const lane = readFileSync(SCRIPT, 'utf8').replace(/^\. "\$REPO\/(scripts\/lanes\/[^"]+\.sh)"$/gm, (_l, file) =>
        readFileSync(join(ROOT, file), 'utf8')
    );
    const lines = lane.split('\n');
    const boards = lines.flatMap((line, i) => {
        if (!/node server\/dist\/offline[\w-]*\.js/.test(line)) return [];
        let start = i;
        while (start > 0 && lines[start - 1]?.trimEnd().endsWith('\\')) start--;
        return [lines.slice(start, i + 1).join('\n')];
    });
    // What the lane itself derives from LANE_HOST and the board URLs its phase files set, taken from the script.
    const derived = lines.filter((l) =>
        /^\s*(LANE_BOARD_BIND|\[ "\$LANE_HOST"|BASE="http)|^(AUTH_BASE|MCP_BASE|MCP_IDP)=/.test(l)
    );
    const token = 'a-lane-config-check-secret-32-chars';
    const preamble = [
        'SECRET_STORE_ENV=(LANE_CONFIG_CHECK=1) # never empty: bash 3.2 reads an empty array as unbound under -u',
        'DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_jobs_test',
        'PORT=8129 CAP_LIGHT_PORT=8130 MINT_PORT=8131 AUTH_PORT=8132 MCP_PORT=8133 MCP_IDP_PORT=8134',
        `PLAN_BASE=git://127.0.0.1:9418 CAP_TOKEN=${token} MCP_TOKEN=${token} PS_TOKEN=${token}`,
        'set -- 8130 /dev/null',
        ...derived.map((l) => l.trim()),
    ].join('\n');
    const printEnv = `"${process.execPath}" -e 'process.stdout.write(JSON.stringify(process.env))'`;
    const launchEnv = (board: string, host: string): NodeJS.ProcessEnv => {
        const run = board.replace(/node server\/dist\/offline[\w-]*\.js.*$/, printEnv);
        const out = execFileSync('/bin/bash', ['-c', `set -eu\nLANE_HOST=${host}\n${preamble}\n${run}\nwait`], {
            env: { PATH: process.env.PATH },
            encoding: 'utf8',
        });
        const env = JSON.parse(out) as NodeJS.ProcessEnv;
        for (const key of ['PATH', 'PWD', 'SHLVL', '_', 'OLDPWD']) delete env[key];
        return env;
    };

    it('finds every board the lane starts', () => {
        expect(boards.length).toBeGreaterThanOrEqual(6);
    });

    it.each(['172.17.0.1', '127.0.0.1'])('every board launch loads under LANE_HOST=%s', (host) => {
        for (const board of boards) {
            const env = launchEnv(board, host);
            expect(() => loadConfig(env, { mode: 'none' }), board).not.toThrow();
        }
    });
});
