import { expect, vitest } from 'vitest';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { BoardJob } from '../../src/board/board.js';
import { loadDriverConfig } from '../../src/config.js';
import { dockerArgs } from '../../src/docker/docker.js';
import { boardIdentity } from '../../src/task-volume.js';
import { withTaskVolume } from './task-volume-daemon.js';
import type { RunOutcome, RunSession } from '../../src/runner.js';
import { ARTIFACT_LIMIT } from '../../src/runner.js';
import { createDockerRunner } from '../../src/docker/docker-runner.js';
import type { RunnerFiles } from '../../src/docker/docker-runner-support.js';
import type { StepSink, SupervisorEndpoint } from '../../src/step-control.js';
import {
    SUPERVISOR_ENV,
    type StepKind,
    type StepRequest,
    type StepResult,
    type SupervisorReport,
} from '../../src/supervisor-contract.js';

/** The board identity the default test config stamps on its group objects. */
export const BOARD = boardIdentity(loadDriverConfig({}));

export const USER = '44444444-4444-4444-8444-444444444444';

export const CONTROL_TOKEN = 'supervisor-control-token';

/** A fixed, valid Factory execution context — the shape master-prompt.test.ts pins; only its
 *  presence matters to this file's own tests, none of which assert its exact text. */
export const MASTER_PROMPT =
    'Factory execution contract (factory-master-prompt/v1)\n\nFactory execution context\n- Mode: standalone';

export const job: BoardJob = {
    id: '11111111-1111-4111-8111-111111111111',
    command: 'fix the failing build',
    rootCommand: 'fix the failing build',
    attempts: 1,
    maxAttempts: 3,
    lastAttempt: false,
    claimSeq: 1,
    leaseToken: '22222222-2222-4222-8222-222222222222',
    leaseExpiresAt: '2026-08-29T12:05:00.000Z',
    executorType: 'claude-code',
    executorRefusal: null,
    planRefusal: null,
    skillRefusal: null,
    masterPrompt: MASTER_PROMPT,
    resumeSessionId: null,
    followUp: false,
    ownSession: false,
    continuesInterrupted: false,
    userId: USER,
    workspacePath: `bellows/${USER}`,
    supervisorEnv: { [SUPERVISOR_ENV.controlUrl]: 'http://driver:8130', [SUPERVISOR_ENV.controlToken]: CONTROL_TOKEN },
};

export const ok = (stdout = ''): StepResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });

/** A daemon call that never answers and rejects only when its own `signal` aborts (#869). */
export const hangsUntilAborted = (options?: { signal?: AbortSignal }): Promise<never> =>
    new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });

/** A daemon call that never answers: it fails only at its own `timeout`, as execFile kills a stalled child (#869). */
export const hangsUntilTimeout = (options?: { timeout?: number }): Promise<never> =>
    new Promise((_resolve, reject) => {
        if (options?.timeout !== undefined) setTimeout(() => reject(new Error('timed out')), options.timeout);
    });

/** Whether `pending` ended within a moment: a wait that ignores the kill signal stays pending. */
export const endsSoon = (pending: Promise<unknown>): Promise<boolean> =>
    Promise.race([
        pending.then(
            () => true,
            () => true
        ),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);

export const FINALIZED: SupervisorReport = {
    id: 'report-1',
    outcome: null,
    cause: null,
    agentExit: 0,
    agentEnd: 'exited',
    drained: true,
    serving: true,
};

/**
 * The supervised-step channel stood in: every step is recorded (with the token it was submitted
 * under) and answered by `answer` — default exit 0, empty — and the supervisor's report is
 * `reported` at once, as a finalized run's would be.
 */
export function fakeSteps(
    answer: (step: StepRequest) => StepResult | Promise<StepResult> = () => ok(),
    reported: SupervisorReport | Promise<SupervisorReport> = FINALIZED
) {
    const submitted: { token: string; step: StepRequest }[] = [];
    const released: string[] = [];
    const sink: StepSink = {
        submit: async (token, step) => {
            submitted.push({ token, step });
            return answer(step);
        },
        awaitReport: () => Promise.resolve(reported),
        agentEnded: () => undefined,
        contacted: () => true,
        release: (token) => {
            released.push(token);
        },
        attach: () => undefined,
        cancel: () => undefined,
    };
    const ofKind = (kind: StepKind) => submitted.filter((entry) => entry.step.kind === kind).map((entry) => entry.step);
    return { sink, submitted, released, steps: () => submitted.map((entry) => entry.step), ofKind };
}

/** A supervisor that answers every step with the sync's `stdout` — by default, a clean sync. */
export const syncSteps = (stdout = '{"ok":true,"reason":null}') => fakeSteps(() => ok(stdout));

/** A daemon that answers every verb with nothing. */
export const emptyDaemon = (async () => ({ stdout: '' })) as unknown as (args: string[]) => Promise<{ stdout: string }>;

export const SESSION = '33333333-3333-4333-8333-333333333333';

export const opencodeJob: BoardJob = { ...job, executorType: 'opencode' };

/** A declared service's `docker run` (issue #773): detached, labelled with its service name. */
export const isServiceRun = (args: string[]): boolean =>
    args[0] === 'run' && args.some((arg) => arg.startsWith('factory.service='));

export const args = (env: NodeJS.ProcessEnv = {}, session: RunSession | null = { id: SESSION, resume: false }) =>
    dockerArgs(loadDriverConfig(env), job, session, { envFile: '/tmp/env-file' });

export const START = '2026-08-20T06:00:00.000Z';

/**
 * A child that streams the given text and exits, the way `spawn`'s product behaves — enough of
 * one for the runner, which reads two streams and a close event and nothing else.
 */
export function fakeChild(stdout: string, stderr: string, code: number | null): ChildProcess {
    const child = new EventEmitter() as ChildProcess;
    const stream = (text: string) => {
        const s = new EventEmitter() as Readable;
        if (text) process.nextTick(() => s.emit('data', Buffer.from(text)));
        return s;
    };
    child.stdout = stream(stdout);
    child.stderr = stream(stderr);
    process.nextTick(() => child.emit('close', code));
    return child;
}

/** The adoption's listing of the job's runners (#829): the one `ps` whose format opens with the container name. */
export const isAdoptListing = (args: string[]): boolean =>
    args[0] === 'ps' && (args[args.indexOf('--format') + 1] ?? '').startsWith('{{.Names}}');

/** Rows of that listing as the daemon answers them: each ends in the container's state. */
export const withState = (rows: string, state: string): string =>
    rows
        .split('\n')
        .filter((row) => row !== '')
        .map((row) => `${row}\t${state}\n`)
        .join('');

/** A child whose stdout arrives as exactly these byte chunks and ends, in one tick, before it exits `code`. */
export function chunkedChild(chunks: Buffer[], code = 0): ChildProcess {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new EventEmitter() as Readable;
    child.stdout = stdout;
    child.stderr = new EventEmitter() as Readable;
    process.nextTick(() => {
        for (const chunk of chunks) stdout.emit('data', chunk);
        stdout.emit('end');
        child.emit('close', code);
    });
    return child;
}

/** A log whose stream ends inside a `€`: its last two bytes begin a character that never completes. */
export const CUT_SHORT = [Buffer.concat([Buffer.from('ok'), Buffer.from('€').subarray(0, 2)])];

/**
 * `body` then a `€` split across two chunks after its first byte (issue #825): decoded chunk by
 * chunk, each half would read as U+FFFD.
 */
export const splitEuro = (body: string): Buffer[] => {
    const euro = Buffer.from('€');
    return [
        Buffer.concat([Buffer.from(body), euro.subarray(0, 1)]),
        Buffer.concat([euro.subarray(1), Buffer.from('\n')]),
    ];
};

/** Below the artifact cap, and above it in multibyte text: [body, the truncated flag it earns]. */
export const SPLIT_EURO_CASES = [
    ['a', false],
    ['€'.repeat(ARTIFACT_LIMIT / 2), true],
] as const;

export const expectWholeEuro = (outcome: RunOutcome | undefined, truncated: boolean): void => {
    expect(outcome?.fullLog?.endsWith('€\n')).toBe(true);
    expect(outcome?.fullLog).not.toContain('�');
    expect(outcome?.output).not.toContain('�');
    expect(Buffer.byteLength(outcome?.fullLog ?? '')).toBeLessThanOrEqual(ARTIFACT_LIMIT);
    expect(outcome?.logTruncated).toBe(truncated);
};

/** A spawn whose every call hands back one {@link fakeChild}. */
export function spawnChild(stdout: string, stderr?: string, code?: number | null): typeof spawn {
    return (() => fakeChild(stdout, stderr as string, code as number | null)) as unknown as typeof spawn;
}

/** A container's id as the daemon prints it: 12 lowercase hex characters, derived from its name. */
export const idOf = (name: string): string => createHash('sha256').update(name).digest('hex').slice(0, 12);

export function labelDaemon({
    readout = '{"ok":true,"reason":null}',
    fail,
}: {
    readout?: string;
    fail?: (args: string[]) => string | null;
} = {}) {
    const containers = new Map<string, Record<string, string>>();
    const calls: string[][] = [];
    const labelsOf = (args: string[]): Record<string, string> => {
        const labels: Record<string, string> = {};
        for (let i = 0; i < args.length; i += 1) {
            if (args[i] === '--label') {
                const [key, value] = (args[i + 1] ?? '').split('=');
                if (key && value !== undefined) labels[key] = value;
            }
        }
        return labels;
    };
    // `label=key=value` matches the value, `label=key` the key's presence — docker's two spellings.
    const filtersOf = (args: string[]): [string, string | null][] => {
        const filters: [string, string | null][] = [];
        for (let i = 0; i < args.length; i += 1) {
            if (args[i] === '--filter' && (args[i + 1] ?? '').startsWith('label=')) {
                const [key, value] = (args[i + 1] ?? '').slice('label='.length).split('=');
                if (key) filters.push([key, value ?? null]);
            }
        }
        return filters;
    };
    const matches = (labels: Record<string, string>, filters: [string, string | null][]): boolean =>
        filters.every(([key, value]) => (value === null ? key in labels : labels[key] === value));
    const listed = (entries: Map<string, Record<string, string>>, args: string[]) => {
        const filters = filtersOf(args);
        if (args.includes('{{json .}}')) {
            // The readiness wait's listing: every matching service container, running.
            const services = [...entries.values()].filter(
                (labels) => labels['factory.service'] && matches(labels, filters)
            );
            return {
                stdout: services
                    .map((labels) =>
                        JSON.stringify({
                            Labels: `factory.service=${labels['factory.service']}`,
                            Image: 'svc:1',
                            State: 'running',
                        })
                    )
                    .join('\n'),
            };
        }
        // The fence's `--format` asks for each object's lease label beside its name or its id, as
        // docker renders it: a container's id is the daemon's 12 hex characters, never its name.
        const format = args[args.indexOf('--format') + 1] ?? '';
        const withLease = format.includes('factory.lease');
        const first = (name: string): string => (format.startsWith('{{.ID}}') ? idOf(name) : name);
        return {
            stdout: [...entries.entries()]
                .filter(([, labels]) => matches(labels, filters))
                .map(([name, labels]) => (withLease ? `${first(name)}\t${labels['factory.lease'] ?? ''}` : first(name)))
                .join('\n'),
        };
    };
    const exec = vitest.fn(async (args: string[]) => {
        calls.push(args);
        const refused = fail?.(args);
        if (refused) {
            throw Object.assign(new Error(`Command failed: docker ${args.join(' ')}`), { stderr: refused });
        }
        if (args[0] === 'ps') return listed(containers, args);
        if (args[0] === 'rm' && args[1] === '-f') {
            for (const id of args.slice(2)) {
                containers.delete(id);
                for (const name of containers.keys()) if (idOf(name) === id) containers.delete(name);
            }
            return { stdout: '' };
        }
        if (args[0] === 'run' && args.includes('--entrypoint')) return { stdout: readout };
        if (isServiceRun(args) || args[0] === 'create') {
            containers.set(args[args.indexOf('--name') + 1]!, labelsOf(args));
            return { stdout: '' };
        }
        return { stdout: '' };
    }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
    return { containers, calls, exec };
}

/**
 * The common daemon stub: the throwaway `run … --entrypoint` container (a readout, a sync)
 * prints `answer` — a function sees the argv and may throw, as a refusing daemon does — and
 * every other docker verb answers empty. Every argv is recorded in `calls`.
 */
export function entrypointAnswers(answer: string | ((args: string[]) => string)): {
    exec: (args: string[]) => Promise<{ stdout: string }>;
    calls: string[][];
} {
    const calls: string[][] = [];
    const exec = vitest.fn(async (args: string[]) => {
        calls.push(args);
        if (args[0] === 'run' && args.includes('--entrypoint')) {
            return { stdout: typeof answer === 'string' ? answer : answer(args) };
        }
        return { stdout: '' };
    });
    return { exec, calls };
}

/**
 * The runner under test: configured from `env`, the daemon stood in by `exec`, and a spawn whose
 * child prints nothing and exits 0 unless the test hands its own.
 */
export function dockerRunner(
    exec: Parameters<typeof createDockerRunner>[2],
    {
        env = {},
        spawn: spawnFn = spawnChild('', '', 0),
        files,
        steps = fakeSteps().sink,
        endpoint,
        sleep = async () => {},
    }: {
        env?: Parameters<typeof loadDriverConfig>[0];
        spawn?: typeof spawn;
        files?: RunnerFiles;
        steps?: StepSink;
        endpoint?: SupervisorEndpoint;
        sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    } = {}
): ReturnType<typeof createDockerRunner> {
    return createDockerRunner(loadDriverConfig(env), spawnFn, exec ? withTaskVolume(exec) : exec, {
        ...(files ? { files } : {}),
        steps,
        ...(endpoint ? { endpoint } : {}),
        // No test waits out a real pause: a test that is about one passes its own.
        sleep,
    });
}
