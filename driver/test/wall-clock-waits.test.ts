/**
 * The verdict, end, kill and adoption waits (#869) are bounded by wall-clock time on one poll, and
 * every request inside a poll gets the time left. Each case moves the clock INSIDE the request, so
 * a wait bounded by a count of polls would keep going long past its bound.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AdoptPrimitives, adoptEarlierRun } from '../src/adopt-skeleton.js';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { awaitFinalized } from '../src/k8s-adopt.js';
import { jobPath } from '../src/k8s-auxspec.js';
import { jobEndsWithin } from '../src/k8s-group.js';
import {
    auxVerdict,
    pollJobToTerminal,
    pollRunnerJobUntilTerminal,
    readJobPodVerdict,
    readVerdict,
} from '../src/k8s-poll.js';
import { ledgerOf } from '../src/k8s-kill.js';
import { runnerName } from '../src/k8s-podspec.js';
import { stopAgent } from '../src/k8s-runner.js';
import { confirmEnded, GROUP_END_WAIT_MS } from '../src/k8s-teardown.js';
import {
    boundedBy,
    LOG_READ_MS,
    POLL_MAX_CONSECUTIVE_FAILURES,
    POLL_MS,
    type K8sDeps,
    type K8sRequestOptions,
} from '../src/k8s-transport.js';
import { AdoptionBlocked, Inconclusive } from '../src/runner.js';
import { KILL_WINDDOWN_MS } from '../src/supervisor-contract.js';
import { finalizeWaitMs } from '../src/supervisor-plan.js';

const NS = 'factory';
const job: BoardJob = {
    id: '11111111-1111-4111-8111-111111111111',
    command: 'fix the failing build',
    attempts: 1,
    maxAttempts: 3,
    lastAttempt: false,
    claimSeq: 2,
    leaseToken: '99999999-9999-4999-8999-999999999999',
    leaseExpiresAt: '2026-08-29T12:05:00.000Z',
    executorType: 'claude-code',
    executorRefusal: null,
    planRefusal: null,
    skillRefusal: null,
    masterPrompt: 'prompt',
    resumeSessionId: null,
    followUp: false,
    ownSession: false,
    continuesInterrupted: false,
    userId: '44444444-4444-4444-8444-444444444444',
    workspacePath: 'bellows/user',
    rootCommand: 'fix the failing build',
};
const RUNNER_JOB = jobPath(NS, runnerName(job));
const RUNNING = JSON.stringify({ metadata: { uid: 'job-uid' }, status: { active: 1 } });
const SLOW_MS = 40_000;

interface Seen {
    method: string;
    path: string;
    timeoutMs: number | undefined;
    signal: AbortSignal | undefined;
}

afterEach(() => vi.restoreAllMocks());

/** A clock only the requests and sleeps move: each request takes `stepMs`, answering `answer`. */
function clockWorld(
    stepMs: number,
    answer: (method: string, path: string, seen: Seen[]) => Promise<{ status: number; body: string }>
) {
    let now = 7_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const seen: Seen[] = [];
    const slept: { ms: number; signal: AbortSignal | undefined }[] = [];
    const deps: K8sDeps = {
        request: async (method, path, _body, options?: K8sRequestOptions) => {
            seen.push({ method, path, timeoutMs: options?.timeoutMs, signal: options?.signal });
            now += stepMs;
            return answer(method, path, seen);
        },
        sleep: async (ms, signal) => {
            slept.push({ ms, signal });
            now += ms;
        },
        config: loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: NS }),
    };
    return { deps, seen, slept, elapsed: () => now - 7_000_000, now: () => now };
}

const running = async () => ({ status: 200, body: RUNNING });
const unavailable = async () => ({ status: 503, body: 'unavailable' });
const timed = (seen: Seen[]) => seen.every((s) => s.timeoutMs !== undefined);

describe('readVerdict', () => {
    it('gives up after the wall-clock patience when every request hangs, not after 15 request timeouts', async () => {
        const world = clockWorld(SLOW_MS, async () => {
            throw new Error('timed out');
        });

        await expect(readVerdict(world.deps, RUNNER_JOB, 'reading the job')).rejects.toThrow(/timed out/);

        expect(world.seen.length).toBeLessThanOrEqual(2);
        expect(world.elapsed()).toBeLessThan(POLL_MAX_CONSECUTIVE_FAILURES * POLL_MS + SLOW_MS * 2);
        expect(world.seen.every((s) => (s.timeoutMs ?? Infinity) <= POLL_MAX_CONSECUTIVE_FAILURES * POLL_MS)).toBe(
            true
        );
    });
});

describe('a full pod log read (#869)', () => {
    const pods = JSON.stringify({ items: [{ metadata: { name: 'pod-1', uid: 'pod-uid' } }] });
    const logWorld = (log: () => Promise<{ status: number; body: string }>) =>
        clockWorld(1, async (_method, path) =>
            path.endsWith('/log') || path.includes('/log?') ? log() : { status: 200, body: pods }
        );
    const read = (world: ReturnType<typeof clockWorld>, strict = false) =>
        readJobPodVerdict(world.deps, 'a-job', { succeeded: true, tail: null, strict }, 'reading the pods');

    it('is given the time of a full transfer, not the 30s of a request', async () => {
        const world = logWorld(async () => ({ status: 200, body: 'whole log' }));

        expect((await read(world)).output).toBe('whole log');
        expect((await read(world, true)).output).toBe('whole log');

        const logs = world.seen.filter((s) => s.path.includes('/log'));
        expect(logs).toHaveLength(2);
        expect(logs.every((s) => (s.timeoutMs ?? 0) > 30_000)).toBe(true);
    });

    it('is flagged truncated, never empty and complete, when its transfer failed', async () => {
        const dropped = await read(
            logWorld(async () => {
                throw new Error('the API server did not answer within 120000ms');
            })
        );
        const refused = await read(logWorld(async () => ({ status: 500, body: 'boom' })));

        expect(dropped).toMatchObject({ output: '', truncated: true });
        expect(refused).toMatchObject({ output: '', truncated: true });
    });

    it('is inconclusive for a strict adoption, bounded by the deadline of a log read', async () => {
        const world = logWorld(async () => {
            throw new Error('the API server did not answer');
        });

        await expect(read(world, true)).rejects.toBeInstanceOf(Inconclusive);

        expect(world.elapsed()).toBeLessThanOrEqual(LOG_READ_MS + POLL_MS);
    });

    it('stays complete and empty for a pod the apiserver says is gone', async () => {
        const gone = await read(logWorld(async () => ({ status: 404, body: '{"kind":"Status"}' })));

        expect(gone).toMatchObject({ output: '', truncated: false });
    });
});

describe('a wait nested in a bounded round (#869)', () => {
    const OUTER_MS = 10_000;

    it('readVerdict retries and sleeps no longer than the round it runs in', async () => {
        const world = clockWorld(1, unavailable);
        const round = boundedBy(world.deps, world.now() + OUTER_MS);

        await expect(readVerdict(round, RUNNER_JOB, 'reading the job')).rejects.toThrow();

        expect(world.elapsed()).toBeLessThanOrEqual(OUTER_MS);
    });

    it('pollJobToTerminal ends with the round it runs in, though its own wait is longer', async () => {
        const world = clockWorld(1, running);
        const round = boundedBy(world.deps, world.now() + OUTER_MS);
        const messages = { what: 'the job', notFound: () => 'gone', errorStatus: () => 'refused', failed: 'failed' };

        await expect(pollJobToTerminal(round, runnerName(job), messages)).rejects.toThrow();

        expect(world.elapsed()).toBeLessThanOrEqual(OUTER_MS);
    });

    it('auxVerdict hands the kill to every request and every pause, and retries no longer than its round', async () => {
        const kill = new AbortController();
        const world = clockWorld(1, running);

        await expect(
            auxVerdict(boundedBy(world.deps, world.now() + OUTER_MS), runnerName(job), kill.signal)
        ).rejects.toThrow();

        expect(world.seen.length).toBeGreaterThan(0);
        expect(world.seen.every((s) => s.signal !== undefined)).toBe(true);
        expect(world.slept.every((s) => s.signal !== undefined)).toBe(true);
        expect(world.elapsed()).toBeLessThanOrEqual(OUTER_MS);
    });

    it('the sweep and the finalizing wait pause on the kill signal, so a kill cuts the pause', async () => {
        const world = clockWorld(1, running);
        const kill = new AbortController();

        await awaitFinalized(world.deps, job, kill.signal);

        expect(world.slept.length).toBeGreaterThan(0);
        expect(world.slept.every((s) => s.signal !== undefined)).toBe(true);
    });

    it('the runner status poll gives every request the kill signal', async () => {
        const kill = (): void => ledgerOf(world.deps).note(job, 'hard');
        const world = clockWorld(1, async (_method, _path, seen) => {
            if (seen.length >= 3) kill();
            return { status: 200, body: RUNNING };
        });
        ledgerOf(world.deps);

        await expect(pollRunnerJobUntilTerminal(world.deps, job)).rejects.toThrow();

        expect(world.seen.length).toBeGreaterThan(0);
        expect(world.seen.every((s) => s.signal !== undefined)).toBe(true);
    });
});

describe('jobEndsWithin', () => {
    it('ends at the bound with the last word `unread` when slow reads prove nothing, each read given the time left', async () => {
        const world = clockWorld(SLOW_MS, unavailable);

        expect(await jobEndsWithin(world.deps, runnerName(job), 60_000)).toBe('unread');

        expect(world.seen.length).toBeLessThanOrEqual(2);
        expect(timed(world.seen)).toBe(true);
    });
});

describe('confirmEnded', () => {
    it('holds at the bound when slow reads show the Job still running, each read given the time left', async () => {
        const world = clockWorld(SLOW_MS, running);

        expect(await confirmEnded(world.deps, { pair: job, jobName: runnerName(job) })).toBe('held');

        expect(world.seen.length).toBeLessThanOrEqual(Math.ceil(GROUP_END_WAIT_MS / SLOW_MS) + 1);
        expect(timed(world.seen)).toBe(true);
    });
});

describe('stopAgent', () => {
    it('escalates to the kill at the bound when slow reads show the agent still running', async () => {
        let killed = false;
        const world = clockWorld(SLOW_MS, async (method, path) => {
            if (method === 'DELETE') killed = true;
            return path === RUNNER_JOB && !killed
                ? { status: 200, body: RUNNING }
                : { status: 404, body: '{"kind":"Status"}' };
        });

        await stopAgent(world.deps, job);

        const beforeKill = world.seen.slice(
            0,
            world.seen.findIndex((s) => s.method === 'DELETE')
        );
        const reads = beforeKill.filter((s) => s.method === 'GET' && s.path === RUNNER_JOB);
        expect(killed).toBe(true);
        expect(reads.length).toBeLessThanOrEqual(Math.ceil(KILL_WINDDOWN_MS / SLOW_MS) + 2);
        expect(reads.every((s) => s.timeoutMs !== undefined)).toBe(true);
    });
});

describe('awaitFinalized', () => {
    it('answers null at the bound when slow reads show the runner still running', async () => {
        const world = clockWorld(SLOW_MS, running);

        expect(await awaitFinalized(world.deps, job, new AbortController().signal)).toBeNull();

        expect(world.seen.length).toBeLessThanOrEqual(Math.ceil(finalizeWaitMs(world.deps.config) / SLOW_MS) + 1);
        expect(timed(world.seen)).toBe(true);
    });

    it('blocks the adoption at the bound when slow reads never answer', async () => {
        const world = clockWorld(SLOW_MS, unavailable);

        await expect(awaitFinalized(world.deps, job, new AbortController().signal)).rejects.toBeInstanceOf(
            AdoptionBlocked
        );

        expect(world.seen.length).toBeLessThanOrEqual(Math.ceil(finalizeWaitMs(world.deps.config) / SLOW_MS) + 1);
    });

    it('gives the pod read after a finished Job the time left, not a fresh request timeout', async () => {
        const world = clockWorld(SLOW_MS, async (_method, path) =>
            path === RUNNER_JOB
                ? { status: 200, body: JSON.stringify({ metadata: { uid: 'job-uid' }, status: { succeeded: 1 } }) }
                : { status: 503, body: 'unavailable' }
        );

        await expect(awaitFinalized(world.deps, job, new AbortController().signal)).rejects.toBeInstanceOf(
            AdoptionBlocked
        );

        expect(timed(world.seen)).toBe(true);
    });

    it('is abandoned by the attempt signal before another read', async () => {
        const kill = new AbortController();
        const world = clockWorld(1_000, async () => {
            kill.abort();
            return { status: 200, body: RUNNING };
        });

        await expect(awaitFinalized(world.deps, job, kill.signal)).rejects.toThrow(/abandoned|stand/i);

        expect(world.seen.length).toBe(1);
    });
});

describe('adoptEarlierRun listing', () => {
    it('hands every listing the deadline and the stand-down of its paced wait (#869)', async () => {
        const stand = new AbortController();
        const list = vi.fn(async () => []);
        const p = {
            pacing: { attempts: 3, retryMs: 2_000, sleep: async () => {} },
            list,
        } as unknown as AdoptPrimitives<never>;

        expect(await adoptEarlierRun(p, new Map(), job, stand.signal)).toBeNull();

        expect(list).toHaveBeenCalledWith(job, { deadline: expect.any(Number), signal: stand.signal });
    });

    it('stands down at the wall-clock bound of its paced listing when each listing is slow', async () => {
        let now = 9_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        let lists = 0;
        const p = {
            pacing: {
                attempts: 3,
                retryMs: 2_000,
                sleep: async (ms: number) => {
                    now += ms;
                },
            },
            list: async () => {
                lists += 1;
                now += 10_000;
                throw new Error('daemon unavailable');
            },
        } as unknown as AdoptPrimitives<never>;

        await expect(adoptEarlierRun(p, new Map(), job)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(lists).toBe(1);
    });
});
