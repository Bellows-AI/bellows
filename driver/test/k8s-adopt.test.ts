/**
 * `adoptFinishedRunner` (`k8s-adopt.ts`) called directly, the contracts the runner-level suites in
 * `k8s.test.ts` cannot state: what the injected `CloseReads` receive, a supervisor log that answers
 * 404 or "never started", a pod list that fails only after the Job list admitted the run, and a
 * sweep that fails after the read. Assertions are on requests and on what the adoption answers or
 * throws, never on how many polls a read took.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { jobPath } from '../src/k8s-auxspec.js';
import { releaseClaimAfterGroupEnd } from '../src/k8s-fence.js';
import { ensureGroup, finishGroup } from '../src/k8s-group.js';
import { type CloseReads, adoptFinishedRunner } from '../src/k8s-adopt.js';
import { pollRunnerJobUntilTerminal } from '../src/k8s-poll.js';
import { jobsPath, runnerJobName, secretName } from '../src/k8s-podspec.js';
import type { K8sDeps } from '../src/k8s-transport.js';
import { AdoptionBlocked, commandMark, ownGroup, type AdoptedRun } from '../src/runner.js';
import { AGENT_CONTAINER, SUPERVISOR_CONTAINER } from '../src/supervisor-contract.js';
import { k8sApiserver, type Special } from './fixtures/k8s-apiserver.js';

const NS = 'factory';
const START = '2026-08-20T06:00:00.000Z';
const SESSION = '33333333-3333-4333-8333-333333333333';
const NEW_TOKEN = '99999999-9999-4999-8999-999999999999';
const OTHER_TOKEN = '55555555-5555-4555-8555-555555555555';

const job: BoardJob = {
    id: '11111111-1111-4111-8111-111111111111',
    command: 'fix the failing build',
    attempts: 1,
    maxAttempts: 1,
    lastAttempt: false,
    claimSeq: 1,
    leaseToken: '22222222-2222-4222-8222-222222222222',
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
const adopter: BoardJob = { ...job, leaseToken: NEW_TOKEN, attempts: 2, claimSeq: 2 };
const opencodeAdopter: BoardJob = { ...adopter, executorType: 'opencode' };
const priorName = runnerJobName(job);
const podName = `${priorName}-xxxxx`;

/** An earlier claim's finished agent runner Job, as the label listing answers it. */
const runnerItem = (
    status: Record<string, unknown> = { succeeded: 1 },
    { lease = job.leaseToken, seq = '1', session = SESSION as string | null } = {}
) => ({
    metadata: {
        name: runnerJobName({ ...job, leaseToken: lease }),
        uid: `uid-${runnerJobName({ ...job, leaseToken: lease })}`,
        labels: { 'factory.job': job.id, 'factory.lease': lease },
        annotations: {
            'factory.claim-seq': seq,
            'factory.command': commandMark(job.command),
            ...(session ? { 'factory.session': session } : {}),
        },
    },
    spec: { template: { spec: { containers: [{ name: SUPERVISOR_CONTAINER }, { name: AGENT_CONTAINER }] } } },
    status: { startTime: START, ...status },
});

/** The adoption's world: `items` listed as the earlier runners, `special` in front of the fake apiserver. */
function world(items: unknown[], special: Special = () => undefined, overrides: Record<string, unknown> = {}) {
    const { routed } = k8sApiserver({ namespace: NS, podName });
    const { request, calls } = routed((method, path, body) => {
        const answer = special(method, path, body);
        if (answer !== undefined) return answer;
        if (method === 'GET' && path.startsWith(`${jobsPath(NS)}?`)) {
            return { status: 200, body: JSON.stringify({ items }) };
        }
    }, overrides);
    const deps: K8sDeps = {
        request,
        sleep: async () => {},
        config: loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: NS }),
    };
    return { deps, calls };
}

const reads = (): CloseReads & { scrape: ReturnType<typeof vi.fn>; attach: ReturnType<typeof vi.fn> } => {
    const scrape = vi.fn(async () => ({ turns: 7, summary: 'closed the loop', blocked: 'needs a token' }));
    const attach = vi.fn(async (_deps, _job, _startedAt, outcome) => {
        outcome.agentTurns = 3;
    });
    return { scrapeClaudeCloseRead: scrape, attachOpencodeOutcome: attach, scrape, attach };
};

const supervisorLogPath = (path: string): boolean => path.includes('/log') && path.includes('container=supervisor');
const deletes = (calls: { method: string; path: string }[]) => calls.filter((call) => call.method === 'DELETE');

describe('the close-time readouts an adoption performs', () => {
    it('hands a claude run to the scrape with the earlier lease, its session and its start, and merges the answer', async () => {
        const { deps, calls } = world([runnerItem()]);
        const injected = reads();

        const adopted = await adoptFinishedRunner(deps, adopter, injected);

        expect(injected.scrape).toHaveBeenCalledTimes(1);
        expect(injected.scrape).toHaveBeenCalledWith(
            expect.objectContaining({ config: deps.config, signal: expect.any(AbortSignal) }),
            expect.objectContaining({ id: job.id, leaseToken: job.leaseToken }),
            SESSION,
            START
        );
        expect(injected.attach).not.toHaveBeenCalled();
        expect(adopted).toMatchObject({
            claimSeq: 1,
            outcome: { exitCode: 0, agentTurns: 7, summary: 'closed the loop', blockedLine: 'needs a token' },
        });
        // The run it read is the one its sweeps now keep, and its Job is not deleted.
        expect(deps.adopted?.get(adopter.leaseToken)).toBe(priorName);
        expect(deletes(calls).some((call) => call.path.startsWith(jobPath(NS, priorName)))).toBe(false);
    });

    it('hands an opencode run to the attach with the earlier lease and its start, and scrapes nothing', async () => {
        const { deps } = world([runnerItem()]);
        const injected = reads();

        const adopted = await adoptFinishedRunner(deps, opencodeAdopter, injected);

        expect(injected.attach).toHaveBeenCalledTimes(1);
        expect(injected.attach).toHaveBeenCalledWith(
            expect.objectContaining({ config: deps.config, signal: expect.any(AbortSignal) }),
            expect.objectContaining({ id: job.id, leaseToken: job.leaseToken }),
            START,
            expect.objectContaining({ exitCode: 0 })
        );
        expect(injected.scrape).not.toHaveBeenCalled();
        expect((adopted as AdoptedRun | null)?.outcome.agentTurns).toBe(3);
    });

    it('reads no close-time readout for a claude run that carries no session', async () => {
        const { deps } = world([runnerItem({ succeeded: 1 }, { session: null })]);
        const injected = reads();

        const adopted = await adoptFinishedRunner(deps, adopter, injected);

        expect(adopted).toMatchObject({ claimSeq: 1, outcome: { exitCode: 0 } });
        expect(injected.scrape).not.toHaveBeenCalled();
        expect(injected.attach).not.toHaveBeenCalled();
    });
});

describe('the supervisor log of an earlier runner', () => {
    const failedRunner = () => runnerItem({ failed: 1 });
    /** A finished group whose pod ran its agent and its supervisor to their ends. */
    const pods = {
        status: 200,
        body: JSON.stringify({
            items: [
                {
                    metadata: { name: podName },
                    status: {
                        phase: 'Failed',
                        containerStatuses: [
                            { name: AGENT_CONTAINER, state: { terminated: { exitCode: 0 } } },
                            { name: SUPERVISOR_CONTAINER, state: { terminated: { exitCode: 70 } } },
                        ],
                    },
                },
            ],
        }),
    };

    it.each([
        ['404', { status: 404, body: '{"kind":"Status"}' }],
        ['a 400 that says the container is waiting to start', { status: 400, body: 'container is waiting to start' }],
    ])(
        'is no report, so the run is taken away and the claim given back, never blocked, when it answers %s',
        async (_label, answer) => {
            const { deps, calls } = world(
                [failedRunner()],
                (_method, path) => (supervisorLogPath(path) ? answer : undefined),
                { pods }
            );

            const adopted = await adoptFinishedRunner(deps, adopter, reads());

            expect(adopted).toBeNull();
            expect(
                calls.some((call) => call.method === 'DELETE' && call.path.includes('/configmaps/factory-job-'))
            ).toBe(true);
            expect(deletes(calls).some((call) => call.path.startsWith(jobPath(NS, priorName)))).toBe(false);
        }
    );

    it('stands the attempt down, deleting nothing, when the pod list fails only after the Job list admitted the run', async () => {
        let podLists = 0;
        const { deps, calls } = world(
            [failedRunner()],
            (method, path) => {
                if (method === 'GET' && path.includes('/pods?') && decodeURIComponent(path).includes('job-name=')) {
                    podLists += 1;
                    // The admission read (and the group's end) are answered; the report's own list is not.
                    return podLists <= 1 ? undefined : { status: 503, body: 'unavailable' };
                }
            },
            { pods }
        );

        await expect(adoptFinishedRunner(deps, adopter, reads())).rejects.toThrow(AdoptionBlocked);

        expect(deletes(calls).filter((call) => !call.path.includes('/configmaps/'))).toEqual([]);
        expect(deps.adopted?.has(adopter.leaseToken)).toBe(false);
    });
});

describe('the sweep after the read', () => {
    /** An older claim's leftover runner Job, which the sweep must delete and cannot. */
    const leftover = () => runnerItem({ active: 1 }, { lease: OTHER_TOKEN, seq: '0' });

    it('stands the attempt down naming the read, keeping the run and its Secret, when a leftover will not go', async () => {
        const stuck = leftover();
        const { deps, calls } = world([runnerItem(), stuck], (method, path) =>
            method === 'DELETE' && path.startsWith(jobPath(NS, stuck.metadata.name))
                ? { status: 503, body: 'unavailable' }
                : undefined
        );

        await expect(adoptFinishedRunner(deps, adopter, reads())).rejects.toThrow(/^the run was read, but /);

        // The read run is not rerun: neither its Job nor its Secret was touched, and it is no longer recorded.
        expect(calls.some((call) => call.method === 'DELETE' && call.path.startsWith(jobPath(NS, priorName)))).toBe(
            false
        );
        expect(calls.some((call) => call.method === 'DELETE' && call.path.endsWith(`/${secretName(job)}`))).toBe(false);
        expect(deps.adopted?.has(adopter.leaseToken)).toBe(false);
    });

    it('deletes the adopted run Secret only after the sweep is done, and keeps the Job', async () => {
        const gone = leftover();
        let listed = [runnerItem(), gone];
        const { deps, calls } = world([], (method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(NS)}?`)) {
                return { status: 200, body: JSON.stringify({ items: listed }) };
            }
            if (method === 'DELETE' && path.startsWith(jobPath(NS, gone.metadata.name))) {
                listed = listed.filter((item) => item !== gone);
                return { status: 200, body: '{}' };
            }
        });

        await adoptFinishedRunner(deps, adopter, reads());

        const order = calls
            .filter((call) => call.method === 'DELETE')
            .map((call) => call.path)
            .filter((path) => !path.includes('/configmaps/'));
        const leftoverAt = order.findIndex((path) => path.startsWith(jobPath(NS, gone.metadata.name)));
        const secretAt = order.findIndex((path) => path.endsWith(`/${secretName(job)}`));
        expect(leftoverAt).toBeGreaterThanOrEqual(0);
        expect(secretAt).toBeGreaterThan(leftoverAt);
        expect(order.some((path) => path.startsWith(jobPath(NS, priorName)))).toBe(false);
    });
});

describe('the supplied stand-down ends every step of an adoption (#869)', () => {
    /** `deps` whose requests for `hang` never answer but reject once their own signal aborts. */
    const hangingOn = (deps: K8sDeps, hang: (method: string, path: string) => boolean, hit: () => void): K8sDeps => ({
        ...deps,
        request: (method, path, body, options) => {
            if (!hang(method, path)) return deps.request(method, path, body, options);
            hit();
            return new Promise((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            });
        },
    });
    const settledOrPending = (pending: Promise<unknown>): Promise<'settled' | 'pending'> =>
        Promise.race([
            pending.then(
                () => 'settled' as const,
                () => 'settled' as const
            ),
            new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 100)),
        ]);

    it.each([
        ['the admission pod read', (_method: string, path: string) => path.includes('/pods')],
        ['the supervisor log read', (_method: string, path: string) => supervisorLogPath(path)],
    ])('ends %s on the supplied signal', async (_name, hang) => {
        const { deps } = world([runnerItem()]);
        const stop = new AbortController();
        let hung = false;
        const pending = adoptFinishedRunner(
            hangingOn(deps, hang, () => (hung = true)),
            adopter,
            reads(),
            stop.signal
        );
        await vi.waitFor(() => expect(hung).toBe(true));
        stop.abort();
        expect(await settledOrPending(pending)).toBe('settled');
    });

    it('hands the close-time scrape a signal the supplied stand-down ends', async () => {
        const { deps } = world([runnerItem()]);
        const injected = reads();
        injected.scrape.mockImplementation(
            (live: K8sDeps) =>
                new Promise((_resolve, reject) => {
                    live.signal?.addEventListener('abort', () => reject(new Error('aborted')));
                })
        );
        const stop = new AbortController();
        const pending = adoptFinishedRunner(deps, adopter, injected, stop.signal);
        await vi.waitFor(() => expect(injected.scrape).toHaveBeenCalled());
        stop.abort();
        expect(await settledOrPending(pending)).toBe('settled');
    });
});

describe('a live run (#829)', () => {
    const RELEASED = 'supervisor: released the agent';
    /** A group whose agent and supervisor both run: the pod of a run a lost driver left going. */
    const runningPods = (agent: Record<string, unknown> = { running: {} }, supervisor = { running: {} }) => ({
        status: 200,
        body: JSON.stringify({
            items: [
                {
                    metadata: { name: podName },
                    status: {
                        phase: 'Running',
                        containerStatuses: [
                            { name: AGENT_CONTAINER, state: agent },
                            { name: SUPERVISOR_CONTAINER, state: supervisor },
                        ],
                    },
                },
            ],
        }),
    });
    const logSays = (body: string) => (_method: string, path: string) =>
        supervisorLogPath(path) ? { status: 200, body } : undefined;
    const liveWorld = (body = `supervisor: serving\n${RELEASED}\n`, extra: unknown[] = []) =>
        world([runnerItem({ active: 1 }), ...extra], logSays(body), { pods: runningPods() });

    it('answers a released, running group as live, with the claim taken and the group recorded under the prior lease', async () => {
        const { deps, calls } = liveWorld();

        const adopted = await adoptFinishedRunner(deps, adopter, reads());

        expect(adopted).toMatchObject({
            live: true,
            claimSeq: 1,
            session: SESSION,
            startedAt: START,
            prior: { id: job.id, leaseToken: job.leaseToken },
        });
        expect(calls.some((call) => call.method === 'POST' && call.path.includes('/configmaps'))).toBe(true);
        expect(deps.adopted?.get(adopter.leaseToken)).toBe(priorName);
        expect(deps.groups?.get(job.leaseToken)).toMatchObject({
            startedAt: START,
            agent: true,
            resumed: true,
            uids: { job: `uid-${priorName}` },
        });
        // The live Job and its Secret are the run's own: never deleted, nor waited for to finalize.
        expect(deletes(calls).some((call) => call.path.startsWith(jobPath(NS, priorName)))).toBe(false);
        expect(deletes(calls).some((call) => call.path.endsWith(`/${secretName(job)}`))).toBe(false);
    });

    it('answers a resumed run its recorded group, creating nothing, under the prior lease it addresses', async () => {
        const { deps, calls } = liveWorld();
        await adoptFinishedRunner(deps, adopter, reads());
        const before = calls.length;
        const taken = ownGroup({ ...adopter, groupLease: job.leaseToken });

        const group = await ensureGroup(deps, taken, { id: SESSION, resume: true });

        expect(group).toMatchObject({ resumed: true, startedAt: START });
        expect(taken.leaseToken).toBe(job.leaseToken);
        expect(calls.slice(before).filter((call) => call.method === 'POST')).toEqual([]);
    });

    describe("the claim of a taken-over group is its holder's, the group the prior lease's", () => {
        const claimDeletes = (calls: { method: string; path: string }[]) =>
            deletes(calls).filter((call) => call.path.includes('/configmaps/'));

        it('ends a taken-over group whose delete went unconfirmed again at the next finish, then gives the claim back', async () => {
            let refusing = true;
            let jobGone = false;
            const { deps, calls } = world(
                [runnerItem({ active: 1 })],
                (method, path) => {
                    if (path.startsWith(jobPath(NS, priorName))) {
                        if (method === 'DELETE') jobGone = true;
                        return method === 'GET' && !jobGone
                            ? {
                                  status: 200,
                                  body: JSON.stringify({ metadata: { uid: `uid-${priorName}` }, status: {} }),
                              }
                            : { status: jobGone ? 404 : 200, body: '{}' };
                    }
                    if (method === 'DELETE' && path.endsWith(`/secrets/${secretName(job)}`) && refusing) {
                        return { status: 500, body: 'unavailable' };
                    }
                    return supervisorLogPath(path)
                        ? { status: 200, body: `supervisor: serving\n${RELEASED}\n` }
                        : undefined;
                },
                { pods: runningPods() }
            );
            await adoptFinishedRunner(deps, adopter, reads());
            const taken = ownGroup({ ...adopter, groupLease: job.leaseToken });

            await finishGroup(deps, taken);
            // The end is unconfirmed under the claim's holder, the new lease: the claim stays.
            expect(claimDeletes(calls)).toEqual([]);

            refusing = false;
            await finishGroup(deps, taken);
            expect(claimDeletes(calls)).toHaveLength(1);
        });

        it('keeps the claim while the taken-over group is still live in this runner', async () => {
            const { deps, calls } = liveWorld();
            await adoptFinishedRunner(deps, adopter, reads());

            await releaseClaimAfterGroupEnd(deps, { ...adopter, groupLease: job.leaseToken });

            // The group is recorded under the prior lease, the claim held by the adopter.
            expect(claimDeletes(calls)).toEqual([]);
        });
    });

    it('sweeps an older attempt but spares the live group', async () => {
        const older = runnerItem({ active: 1 }, { lease: OTHER_TOKEN, seq: '0' });
        let listed = [runnerItem({ active: 1 }), older];
        const { deps, calls } = world(
            [],
            (method, path) => {
                if (method === 'GET' && path.startsWith(`${jobsPath(NS)}?`)) {
                    return { status: 200, body: JSON.stringify({ items: listed }) };
                }
                if (method === 'DELETE' && path.startsWith(jobPath(NS, older.metadata.name))) {
                    listed = listed.filter((item) => item !== older);
                    return { status: 200, body: '{}' };
                }
                return logSays(`${RELEASED}\n`)(method, path);
            },
            { pods: runningPods() }
        );

        const adopted = await adoptFinishedRunner(deps, adopter, reads());

        expect(adopted).toMatchObject({ live: true });
        expect(deletes(calls).some((call) => call.path.startsWith(jobPath(NS, older.metadata.name)))).toBe(true);
        expect(deletes(calls).some((call) => call.path.startsWith(jobPath(NS, priorName)))).toBe(false);
    });

    it('redoes the run (null, nothing deleted) when the supervisor never released the agent', async () => {
        const { deps, calls } = liveWorld('supervisor: serving\n');

        expect(await adoptFinishedRunner(deps, adopter, reads())).toBeNull();
        expect(deletes(calls)).toEqual([]);
        expect(deps.groups?.has(job.leaseToken) ?? false).toBe(false);
    });

    it.each([
        ['an unserving apiserver', { status: 500, body: 'boom' }],
        ['a log that is gone', { status: 404, body: '{"kind":"Status"}' }],
    ])('blocks the attempt, deleting nothing, on %s for the release evidence', async (_label, answer) => {
        const { deps, calls } = world(
            [runnerItem({ active: 1 })],
            (_m, path) => (supervisorLogPath(path) ? answer : undefined),
            {
                pods: runningPods(),
            }
        );

        await expect(adoptFinishedRunner(deps, adopter, reads())).rejects.toBeInstanceOf(AdoptionBlocked);
        expect(deletes(calls).filter((call) => call.path.startsWith(jobPath(NS, priorName)))).toEqual([]);
        expect(deps.groups?.has(job.leaseToken) ?? false).toBe(false);
    });

    it('blocks the attempt when the log read throws', async () => {
        const { deps } = liveWorld();
        const thrown: K8sDeps = {
            ...deps,
            request: (method, path, body, options) =>
                supervisorLogPath(path)
                    ? Promise.reject(new Error('socket hang up'))
                    : deps.request(method, path, body, options),
        };

        await expect(adoptFinishedRunner(thrown, adopter, reads())).rejects.toBeInstanceOf(AdoptionBlocked);
    });

    it('blocks the attempt when a running pod reports no container states', async () => {
        const { deps } = world([runnerItem({ active: 1 })], logSays(RELEASED), {
            pods: {
                status: 200,
                body: JSON.stringify({ items: [{ metadata: { name: podName }, status: { phase: 'Running' } }] }),
            },
        });

        await expect(adoptFinishedRunner(deps, adopter, reads())).rejects.toBeInstanceOf(AdoptionBlocked);
    });

    it('deletes and takes nothing once the attempt stood down', async () => {
        const { deps, calls } = liveWorld();
        const stop = new AbortController();
        stop.abort();

        await expect(adoptFinishedRunner(deps, adopter, reads(), stop.signal)).rejects.toThrow();
        expect(deletes(calls)).toEqual([]);
        expect(calls.some((call) => call.method === 'POST' && call.path.includes('/configmaps'))).toBe(false);
    });

    it('is live again for a later claim of the same run', async () => {
        const { deps } = liveWorld();
        await adoptFinishedRunner(deps, adopter, reads());

        const later = { ...adopter, leaseToken: OTHER_TOKEN, claimSeq: 3 };
        expect(await adoptFinishedRunner(deps, later, reads())).toMatchObject({ live: true, claimSeq: 1 });
    });

    describe('whose agent exited while its supervisor still serves the steps', () => {
        const SERVED = 'supervisor: stopped serving the steps';
        const exited = { terminated: { exitCode: 0 } };
        const exitedWorld = (
            body: string,
            supervisor: Record<string, unknown> = { running: {} },
            extra: unknown[] = []
        ) => {
            let listed = [runnerItem({ active: 1 }), ...extra];
            return world(
                [],
                (method, path) => {
                    if (method === 'GET' && path.startsWith(`${jobsPath(NS)}?`)) {
                        return { status: 200, body: JSON.stringify({ items: listed }) };
                    }
                    if (
                        method === 'DELETE' &&
                        extra.length > 0 &&
                        path.startsWith(jobPath(NS, runnerJobName({ ...job, leaseToken: OTHER_TOKEN })))
                    ) {
                        listed = listed.filter((item) => !extra.includes(item));
                        return { status: 200, body: '{}' };
                    }
                    return logSays(body)(method, path);
                },
                { pods: runningPods(exited, supervisor as { running: object }) }
            );
        };
        const jobDeletes = (calls: { method: string; path: string }[]) =>
            deletes(calls).filter((call) => call.path.startsWith(jobPath(NS, priorName)));

        it('is taken over as live, with no finalize wait: the Job and its Secret are spared, an older attempt swept', async () => {
            const older = runnerItem({ active: 1 }, { lease: OTHER_TOKEN, seq: '0' });
            const { deps, calls } = exitedWorld(`supervisor: serving\n${RELEASED}\n`, { running: {} }, [older]);

            const adopted = await adoptFinishedRunner(deps, adopter, reads());

            expect(adopted).toMatchObject({ live: true, claimSeq: 1, startedAt: START });
            expect(deps.groups?.get(job.leaseToken)).toMatchObject({
                resumed: true,
                uids: { job: `uid-${priorName}` },
            });
            expect(jobDeletes(calls)).toEqual([]);
            expect(deletes(calls).some((call) => call.path.endsWith(`/${secretName(job)}`))).toBe(false);
            expect(deletes(calls).some((call) => call.path.startsWith(jobPath(NS, older.metadata.name)))).toBe(true);
            // No finalize poll of the Job: only the one admission read of its pods and the log.
            expect(
                calls.filter((call) => call.method === 'GET' && call.path.startsWith(jobPath(NS, priorName)))
            ).toEqual([]);
        });

        it('blocks the attempt when the listed Job carries no uid to tear down by', async () => {
            const noUid = runnerItem({ active: 1 });
            delete (noUid.metadata as { uid?: string }).uid;
            const { deps, calls } = world([noUid], logSays(`${RELEASED}\n`), {
                pods: runningPods(exited),
            });

            await expect(adoptFinishedRunner(deps, adopter, reads())).rejects.toBeInstanceOf(AdoptionBlocked);
            expect(jobDeletes(calls)).toEqual([]);
        });

        // Characterization: a supervisor that logged it stopped serving is the finalize-wait path, unchanged.
        it('is waited out, not taken over, once the supervisor logged that it stopped serving', async () => {
            const { deps } = exitedWorld(`${RELEASED}\n${SERVED}\n`);

            const adopted = await adoptFinishedRunner(deps, adopter, reads());

            expect((adopted as { live?: boolean } | null)?.live).not.toBe(true);
        });

        // Characterization: a supervisor that is not running is waited out for its report.
        it('is waited out when the supervisor container is not running', async () => {
            const { deps, calls } = exitedWorld(`${RELEASED}\n`, { terminated: { exitCode: 0 } });

            const adopted = await adoptFinishedRunner(deps, adopter, reads()).catch((e: unknown) => e);

            expect((adopted as { live?: boolean } | null)?.live).not.toBe(true);
            expect(calls.some((call) => call.method === 'GET' && call.path.startsWith(jobPath(NS, priorName)))).toBe(
                true
            );
            expect(jobDeletes(calls)).toEqual([]);
        });

        // Characterization: an unread supervisor state or log never makes the group live, never redoes it.
        it.each([
            ['a log the apiserver refuses', () => ({ status: 500, body: 'boom' })],
            ['a log that is gone', () => ({ status: 404, body: '{"kind":"Status"}' })],
            ['a log read that throws', () => 'throw'],
        ])('is waited out, never taken over or swept, on %s', async (_label, answer) => {
            const { deps, calls } = exitedWorld('');
            const refusing: K8sDeps = {
                ...deps,
                request: (method, path, body, options) => {
                    if (!supervisorLogPath(path)) return deps.request(method, path, body, options);
                    const out = answer();
                    return typeof out === 'string' ? Promise.reject(new Error('socket hang up')) : Promise.resolve(out);
                },
            };

            const adopted = await adoptFinishedRunner(refusing, adopter, reads()).catch((e: unknown) => e);

            expect((adopted as { live?: boolean } | null)?.live).not.toBe(true);
            expect(adopted).not.toBeInstanceOf(AdoptionBlocked);
            expect(jobDeletes(calls)).toEqual([]);
        });

        // Characterization: no release line is an agent that never started or was not released: finalize path.
        it('is waited out when the supervisor never logged the release', async () => {
            const { deps } = exitedWorld('supervisor: serving\n');

            const adopted = await adoptFinishedRunner(deps, adopter, reads());

            expect((adopted as { live?: boolean } | null)?.live).not.toBe(true);
        });

        // Characterization: a pod that lists no supervisor container says nothing of it: finalize path.
        it('is waited out when the pod lists no supervisor container status', async () => {
            const pods = {
                status: 200,
                body: JSON.stringify({
                    items: [
                        {
                            metadata: { name: podName },
                            status: { phase: 'Running', containerStatuses: [{ name: AGENT_CONTAINER, state: exited }] },
                        },
                    ],
                }),
            };
            const { deps, calls } = world([runnerItem({ active: 1 })], logSays(`${RELEASED}\n`), { pods });

            const adopted = await adoptFinishedRunner(deps, adopter, reads()).catch((e: unknown) => e);

            expect((adopted as { live?: boolean } | null)?.live).not.toBe(true);
            expect(jobDeletes(calls)).toEqual([]);
        });

        // Characterization: the taken-over run on an exited agent is over once the supervisor's report is
        // in hand, whatever the Job still shows — no `go`, no pod read to wait for.
        it('ends the followed run at the supervisor report with the Job still active, ordering nothing', async () => {
            const { deps: base, calls } = exitedWorld(`${RELEASED}\n`);
            await adoptFinishedRunner(base, adopter, reads());
            const taken = ownGroup({ ...adopter, groupLease: job.leaseToken });
            const before = calls.length;
            const deps: K8sDeps = {
                ...base,
                request: (method, path, body, options) =>
                    method === 'GET' && path === jobPath(NS, priorName)
                        ? Promise.resolve({
                              status: 200,
                              body: JSON.stringify({ metadata: { uid: `uid-${priorName}` }, status: { active: 1 } }),
                          })
                        : base.request(method, path, body, options),
            };
            // The report is in hand at the first poll; the Job reads active.
            const polled = await pollRunnerJobUntilTerminal(deps, taken, { over: () => true });

            expect(polled).toEqual({ timedOut: false, jobSucceeded: false });
            expect(calls.slice(before).filter((call) => call.method !== 'GET')).toEqual([]);
        });

        it('deletes nothing once the attempt stood down during the log read', async () => {
            const { deps, calls } = exitedWorld(`${RELEASED}\n`);
            const stop = new AbortController();
            const standing: K8sDeps = {
                ...deps,
                request: (method, path, body, options) => {
                    if (supervisorLogPath(path)) stop.abort();
                    return deps.request(method, path, body, options);
                },
            };

            await expect(adoptFinishedRunner(standing, adopter, reads(), stop.signal)).rejects.toThrow();
            expect(deletes(calls)).toEqual([]);
        });
    });
});
