import { describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../../src/board/board.js';
import { loadDriverConfig } from '../../src/config.js';
import { Inconclusive } from '../../src/runner.js';
import type { HelperPlan } from '../../src/helpers.js';
import type { K8sDeps, K8sRequest } from '../../src/k8s/k8s-transport.js';
import { ledgerOf, RunnerKilled } from '../../src/k8s/k8s-kill.js';
import { pollRunnerJobUntilTerminal, runnerLossOf } from '../../src/k8s/k8s-poll.js';
import { jobsPath, runnerJobName } from '../../src/k8s/k8s-podspec.js';
import { jobPath } from '../../src/k8s/k8s-auxspec.js';
import { job, SESSION, namespace, podName, fakeRequest, runner } from '../fixtures/k8s-suite.js';

describe('the paused deadline for an agent question', () => {
    it('removes the deadline while waiting and restores it with the actual elapsed wait', async () => {
        const spec: { activeDeadlineSeconds?: number } = { activeDeadlineSeconds: 7200 };
        const annotations: Record<string, string> = {};
        const patches: unknown[] = [];
        const request: K8sRequest = async (method, _path, body) => {
            if (method === 'PATCH') {
                const patch = body as {
                    spec: { activeDeadlineSeconds: number | null };
                    metadata: { annotations: Record<string, string | null> };
                };
                // A merge patch removes a key set to null.
                if (patch.spec.activeDeadlineSeconds === null) delete spec.activeDeadlineSeconds;
                else spec.activeDeadlineSeconds = patch.spec.activeDeadlineSeconds;
                for (const [key, value] of Object.entries(patch.metadata.annotations)) {
                    if (value === null) delete annotations[key];
                    else annotations[key] = value;
                }
                patches.push(body);
            }
            return { status: 200, body: JSON.stringify({ spec, metadata: { uid: 'job-uid', annotations } }) };
        };
        const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
        try {
            const r = runner(request);
            await Promise.all([r.pauseDeadline(job, true), r.pauseDeadline(job, true)]);
            expect(spec.activeDeadlineSeconds).toBeUndefined();
            expect(patches).toHaveLength(1);
            now.mockReturnValue(1000 + 48 * 3600 * 1000);
            await r.pauseDeadline(job, false);
            expect(spec.activeDeadlineSeconds).toBe(7200 + 48 * 3600);
            await r.pauseDeadline(job, false);
            expect(patches).toHaveLength(2);
        } finally {
            now.mockRestore();
        }
    });

    it('does nothing when the runner Job is gone', async () => {
        const request = vi.fn(async () => ({ status: 404, body: '{}' }));
        await runner(request).pauseDeadline(job, true);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('rejects, sending no PATCH, when the Job GET answers null', async () => {
        const methods: string[] = [];
        const request: K8sRequest = async (method) => {
            methods.push(method);
            return { status: 200, body: 'null' };
        };
        await expect(runner(request).pauseDeadline(job, true)).rejects.toThrow(/reading the runner job/);
        expect(methods).toEqual(['GET']);
    });

    it.each(['not json', '{"deadline":"60","at":1}', '{"deadline":60}', 'null'])(
        'rejects, sending no PATCH, when a resume finds the saved annotation %s',
        async (saved) => {
            const methods: string[] = [];
            const request: K8sRequest = async (method) => {
                methods.push(method);
                return {
                    status: 200,
                    body: JSON.stringify({
                        metadata: { uid: 'job-uid', annotations: { 'bellows.ai/paused-deadline': saved } },
                    }),
                };
            };
            await expect(runner(request).pauseDeadline(job, false)).rejects.toThrow(/saved deadline/);
            expect(methods).toEqual(['GET']);
        }
    );

    it('rejects a refused pause so it can be retried', async () => {
        const request: K8sRequest = async (method) =>
            method === 'PATCH'
                ? { status: 403, body: '{}' }
                : {
                      status: 200,
                      body: JSON.stringify({ spec: { activeDeadlineSeconds: 60 }, metadata: { uid: 'job-uid' } }),
                  };
        await expect(runner(request).pauseDeadline(job, true)).rejects.toThrow(/pausing or resuming/);
    });

    it('preconditions the PATCH on the uid of the Job it read', async () => {
        const patches: { metadata: { uid?: string } }[] = [];
        const request: K8sRequest = async (method, _path, body) => {
            if (method === 'PATCH') patches.push(body as (typeof patches)[number]);
            return {
                status: 200,
                body: JSON.stringify({ spec: { activeDeadlineSeconds: 60 }, metadata: { uid: 'job-uid' } }),
            };
        };
        await runner(request).pauseDeadline(job, true);
        expect(patches.map((patch) => patch.metadata.uid)).toEqual(['job-uid']);
    });

    // A Job whose incarnation cannot be named could be a replacement under the name (#869): no write.
    it.each([
        ['no uid', { spec: { activeDeadlineSeconds: 120 }, metadata: {} }],
        ['no metadata', { spec: { activeDeadlineSeconds: 120 } }],
        ['an empty uid', { spec: { activeDeadlineSeconds: 120 }, metadata: { uid: '' } }],
        ['a deadline that is no number', { spec: { activeDeadlineSeconds: '120' }, metadata: { uid: 'job-uid' } }],
        ['annotations that are not strings', { spec: {}, metadata: { uid: 'job-uid', annotations: { a: 1 } } }],
    ])('rejects, sending no PATCH, when the Job GET answers %s', async (_name, body) => {
        const methods: string[] = [];
        const request: K8sRequest = async (method) => {
            methods.push(method);
            return { status: 200, body: JSON.stringify(body) };
        };
        await expect(runner(request).pauseDeadline(job, true)).rejects.toThrow(/reading the runner job/);
        expect(methods).toEqual(['GET']);
    });
});

describe('a Stop on kubernetes (issue #427)', () => {
    it('a Stop mid-run resolves run() as a killed outcome, as docker does', async () => {
        const base = fakeRequest({ job: { status: 200, body: JSON.stringify({ status: { active: 1 } }) } });
        let deleted = false;
        let r: ReturnType<typeof runner> | null = null;
        const request: K8sRequest = (method, path, body) => {
            if (path.startsWith(jobPath(namespace, runnerJobName(job)))) {
                if (method === 'DELETE') {
                    deleted = true;
                    return Promise.resolve({ status: 200, body: '{}' });
                }
                if (method === 'GET') {
                    // The heartbeat's Stop lands while the run is polling: the loop calls kill().
                    if (!deleted) void r?.kill(job);
                    if (deleted) return Promise.resolve({ status: 404, body: '{"kind":"Status"}' });
                }
            }
            return base.request(method, path, body);
        };
        r = runner(request);
        // Expected for parity with docker (whose killed container resolves exit 137): an outcome
        // the loop's stopped path can park. Observed: a rejection, which the loop treats as
        // "could not run, leaving it to the lease" — no session report, no artifacts, no suspend.
        await expect(r.run(job, { id: SESSION, resume: false })).resolves.toMatchObject({ started: true });
    });

    // #829: an abandoned run's Job is the next holder's: the poll ends, deleting and recording nothing.
    it('an abandoned run stops polling its Job and deletes nothing', async () => {
        const base = fakeRequest({ job: { status: 200, body: JSON.stringify({ status: { active: 1 } }) } });
        const methods: string[] = [];
        let r: ReturnType<typeof runner> | null = null;
        let abandoned = false;
        let polls = 0;
        const request: K8sRequest = (method, path, body) => {
            if (path.startsWith(jobPath(namespace, runnerJobName(job)))) {
                methods.push(method);
                if (method === 'GET') {
                    polls += 1;
                    if (polls === 2) {
                        abandoned = true;
                        r?.abandon(job);
                    }
                    if (abandoned && polls > 4) throw new Error('still polling an abandoned run');
                }
            }
            return base.request(method, path, body);
        };
        r = runner(request);

        await expect(r.run(job, { id: SESSION, resume: false })).resolves.toMatchObject({ started: true });

        expect(methods).not.toContain('DELETE');
    });

    // U2: on Stop the loop's raceStep abandons a pre-helper and the heartbeat calls kill(job),
    // which deletes the runner Job and the services only. The helper's aux Job is deleted in
    // runHelper's finally, i.e. only once helperVerdict returns — the Job runs to completion.
    it('a Stop (kill) during a pre-helper deletes its aux Job promptly', async () => {
        const base = fakeRequest();
        const helperJob: BoardJob = { ...job, repo: 'Bellows-AI/bellows' };
        let helperName: string | null = null;
        let helperDeleted = false;
        let finished = false;
        const request: K8sRequest = (method, path, body) => {
            if (method === 'POST' && path === jobsPath(namespace) && helperName === null) {
                helperName = (body as { metadata: { name: string } }).metadata.name;
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (helperName !== null && path.startsWith(jobPath(namespace, helperName))) {
                if (method === 'DELETE') {
                    helperDeleted = true;
                    return Promise.resolve({ status: 200, body: '{}' });
                }
                // The helper is still running: pending on every poll, answered as a macrotask.
                const answer = finished
                    ? { status: 404, body: '{"kind":"Status"}' }
                    : { status: 200, body: JSON.stringify({ status: { active: 1 } }) };
                return new Promise((resolve) => setTimeout(() => resolve(answer), 1));
            }
            return base.request(method, path, body);
        };
        const r = runner(request);
        const helperPlan: HelperPlan = { helperId: 'noop', phase: 'pre', input: null, githubWriting: true };
        const running = r.runHelper(helperJob, helperPlan, { token: 'ghs_fresh' });
        try {
            while (helperName === null) await new Promise((resolve) => setTimeout(resolve, 1));
            await r.kill(helperJob); // the heartbeat's Stop
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(helperDeleted).toBe(true);
        } finally {
            finished = true;
            await running;
        }
    });
});

describe('a Job status read as a typed answer (#869)', () => {
    const malformed = JSON.stringify({ status: { succeeded: 'x' } });
    const depsOf = (): K8sDeps => ({
        request: async () => ({ status: 200, body: malformed }),
        sleep: async () => {},
        config: loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }),
    });

    it('reads malformed counters as Inconclusive on the runner poll, never a TypeError or pending', async () => {
        await expect(pollRunnerJobUntilTerminal(depsOf(), job)).rejects.toBeInstanceOf(Inconclusive);
    });
});

describe('the run wait ends on the clock (#869)', () => {
    const pendingBody = JSON.stringify({ status: { active: 1 } });

    it('ends the runner poll promptly when the attempt is killed during its pause', async () => {
        const deps: K8sDeps = {
            request: async () => ({ status: 200, body: pendingBody }),
            sleep: (_ms, signal) =>
                new Promise((_resolve, reject) => {
                    signal?.addEventListener('abort', () => reject(new Error('woken by the abort')), { once: true });
                }),
            config: loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }),
        };
        const polling = pollRunnerJobUntilTerminal(deps, job);
        setTimeout(() => ledgerOf(deps).note(job, 'hard'), 10);
        await expect(polling).rejects.toBeInstanceOf(RunnerKilled);
    });
});

describe('the agent container read over before the supervisor reports (#920)', () => {
    const pendingBody = JSON.stringify({ status: { active: 1 } });
    const agent = (state: unknown) => ({ name: 'agent', image: 'runner:1', state });
    const podListing = (containers: unknown[]): string =>
        JSON.stringify({
            items: [{ metadata: { name: podName }, status: { phase: 'Running', containerStatuses: containers } }],
        });
    const poll = async (answer: (path: string) => { status: number; body: string }) => {
        let polls = 0;
        const told: number[] = [];
        const deps: K8sDeps = {
            request: async (_method, path) => {
                polls += 1;
                return answer(path);
            },
            sleep: async () => {},
            config: loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }),
        };
        await pollRunnerJobUntilTerminal(deps, job, {
            // The supervisor's report ends the poll; here a bounded number of reads stands in for it.
            over: () => polls > 12,
            agentEnded: () => void told.push(polls),
        });
        return told;
    };
    const answering = (pods: { status: number; body: string }) => (path: string) =>
        path.includes('/pods') ? pods : { status: 200, body: pendingBody };

    it('tells the supervisor, once, when the pod list shows the agent container terminated', async () => {
        const ended = answering({
            status: 200,
            body: podListing([agent({ terminated: { exitCode: 1, reason: 'Error' } })]),
        });
        expect(await poll(ended)).toHaveLength(1);
    });

    it.each([
        ['running', podListing([agent({ running: {} })])],
        ['another container terminated', podListing([{ name: 'exporter', state: { terminated: { exitCode: 1 } } }])],
        ['a pod list that is null', 'null'],
        ['a pod list that cannot be read', 'not json'],
    ])('says nothing while the agent container reads %s', async (_name, body) => {
        expect(await poll(answering({ status: 200, body }))).toEqual([]);
    });

    it('says nothing when the pod list request fails', async () => {
        expect(await poll(answering({ status: 500, body: 'boom' }))).toEqual([]);
    });
});

describe('runnerLossOf (issue #560)', () => {
    const exited = (exitCode: number) => ({
        metadata: { name: 'runner-pod' },
        status: { phase: 'Failed', containerStatuses: [{ state: { terminated: { exitCode } } }] },
    });

    it('is no loss when the live pod says the agent ended the run', () => {
        expect(runnerLossOf([exited(1)])).toBeNull();
    });

    it('names a pod the kubelet evicted, in its own words', () => {
        expect(
            runnerLossOf([
                { ...exited(137), status: { ...exited(137).status, reason: 'Evicted', message: 'low on memory' } },
            ])
        ).toBe('the runner pod was taken away before it exited (Evicted: low on memory)');
    });

    it('names a pod the control plane marked a disruption target', () => {
        const pod = {
            ...exited(137),
            status: {
                ...exited(137).status,
                conditions: [
                    {
                        type: 'DisruptionTarget',
                        status: 'True',
                        reason: 'DeletionByTaintManager',
                        message: 'node removed',
                    },
                ],
            },
        };
        expect(runnerLossOf([pod])).toBe(
            'the runner pod was taken away before it exited (DeletionByTaintManager: node removed)'
        );
    });

    it('names a runner with no live pod left as deleted', () => {
        expect(runnerLossOf([])).toBe(
            'the runner pod was deleted before it exited (evicted, drained or its node removed)'
        );
        expect(
            runnerLossOf([{ ...exited(137), metadata: { name: 'p', deletionTimestamp: '2026-01-01T00:00:00Z' } }])
        ).toBe('the runner pod was deleted before it exited (evicted, drained or its node removed)');
    });
});
