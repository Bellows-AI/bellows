import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../../src/board/board.js';
import { loadDriverConfig } from '../../src/config.js';
import { AGENT_CONTAINER, SUPERVISOR_CONTAINER } from '../../src/supervisor-contract.js';
import { AdoptionBlocked, commandMark } from '../../src/runner.js';
import type { K8sMethod, K8sRequest } from '../../src/k8s/k8s-transport.js';
import { jobsPath, runnerJobName, secretName } from '../../src/k8s/k8s-podspec.js';
import { jobPath } from '../../src/k8s/k8s-auxspec.js';
import type { Call } from '../fixtures/k8s-apiserver.js';
import {
    job,
    SESSION,
    namespace,
    claimServer,
    fakeRequest,
    routed,
    stepOk,
    fakeSteps,
    supervisedRunner,
    runner,
    NEW_TOKEN,
    START,
    claimPathFor,
} from '../fixtures/k8s-suite.js';

/** The teardown's writer-pod list (`writerPodsPath`): every pod of one (job, lease) pair. */
const isWriterPodList = (path: string): boolean =>
    /\/pods\?labelSelector=factory\.job=[^,]+,factory\.lease=[0-9a-f-]+$/.test(decodeURIComponent(path));

/*
 * Issue #821 D16, the kubernetes half: every teardown of a runner Job — a kill, a finish, a sync
 * that failed or threw, a reclaim group — deletes the attempt's two Secrets first, each answer
 * read, then the Job, then confirms the Job gone and no writer pod left. Anything short of that
 * keeps the checkout claim: a refused Secret delete suspends the Job (still listed, so the next
 * pass can derive the Secrets from it) and never deletes it.
 */
describe('acknowledged Secret-first teardown (#821 D16)', () => {
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/bellows' };
    const SESSION_OF = { id: SESSION, resume: false };
    const secretsBase = `/api/v1/namespaces/${namespace}/secrets`;
    const endpoint = {
        open: async () => ({ url: 'http://driver:8130', token: 'reclaim-token' }),
        close: () => undefined,
    };
    interface Faults {
        /** What a Secret delete answers, by the Secret's name: refused (500), a transport throw, or as ever. */
        secret?: (name: string) => 'refused' | 'throws' | null;
        jobDelete?: 'refused';
        /** The Job keeps reading present after its delete, through the whole bound. */
        jobLingers?: boolean;
        /** What the writer-pod list (`factory.job=…,factory.lease=…`) answers. */
        writerPods?: unknown[];
    }

    /** The cluster, its faults armed once the group's Job is POSTed: whatever ended before is unaffected. */
    const cluster = (jobName: string, faults: Faults, overrides: Record<string, unknown> = {}) => {
        let armed = false;
        const watched = () => jobName;
        return routed((method, path, body) => {
            if (method === 'POST' && path === jobsPath(namespace)) {
                const meta = (body as { metadata?: { name?: string; labels?: Record<string, string> } } | undefined)
                    ?.metadata;
                if (meta?.name !== undefined && meta.name === watched()) armed = true;
                return;
            }
            if (!armed) return;
            const jobAt = jobPath(namespace, watched());
            if (method === 'DELETE' && path.startsWith(`${secretsBase}/`)) {
                const fault = faults.secret?.(path.slice(secretsBase.length + 1));
                if (fault === 'throws') return Promise.reject(new Error('connection reset by peer'));
                if (fault === 'refused') return { status: 500, body: 'unavailable' };
            }
            if (method === 'DELETE' && path.startsWith(`${jobAt}?`) && faults.jobDelete === 'refused') {
                return { status: 500, body: 'unavailable' };
            }
            if (method === 'GET' && path === jobAt && faults.jobLingers) {
                return { status: 200, body: JSON.stringify({ metadata: { uid: 'job-uid-1' }, status: {} }) };
            }
            if (method === 'GET' && faults.writerPods && isWriterPodList(path)) {
                return { status: 200, body: JSON.stringify({ items: faults.writerPods }) };
            }
        }, overrides);
    };

    const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' });
    const build = (request: K8sRequest, steps = fakeSteps()) =>
        supervisedRunner(config, request, async () => {}, { steps: steps.sink, endpoint });

    interface Lifecycle {
        pair: BoardJob;
        jobName: string;
        drive(request: K8sRequest): Promise<void>;
        /** The fakeRequest answers the lifecycle runs against. */
        overrides?: Record<string, unknown>;
    }
    /** The cluster one lifecycle runs on, with `faults` armed once its group's Job is POSTed. */
    const clusterOf = (life: Lifecycle, faults: Faults) => cluster(life.jobName, faults, life.overrides);
    const runnerGroup = { pair: repoJob, jobName: runnerJobName(repoJob) };
    const LIFECYCLES: Record<string, Lifecycle> = {
        kill: {
            ...runnerGroup,
            async drive(request) {
                const r = build(request);
                await r.syncCheckout(repoJob, undefined, SESSION_OF);
                await r.kill(repoJob);
            },
        },
        // A group whose Job does not end by itself within the bound: the one `finish` ends destructively.
        finish: {
            ...runnerGroup,
            overrides: { job: { status: 200, body: JSON.stringify({ metadata: { uid: 'job-uid-1' }, status: {} }) } },
            async drive(request) {
                const r = build(request);
                await r.syncCheckout(repoJob, undefined, SESSION_OF);
                await r.finish(repoJob);
            },
        },
        'failed sync': {
            ...runnerGroup,
            async drive(request) {
                const steps = fakeSteps((step) =>
                    stepOk(step.kind === 'sync' ? '{"ok":false,"reason":"worktree sync failed: no space left"}\n' : '')
                );
                expect((await build(request, steps).syncCheckout(repoJob, undefined, SESSION_OF)).ok).toBe(false);
            },
        },
        'thrown sync': {
            ...runnerGroup,
            async drive(request) {
                const steps = fakeSteps(() => {
                    throw new Error('the step channel closed');
                });
                await expect(build(request, steps).syncCheckout(repoJob, undefined, SESSION_OF)).rejects.toThrow(
                    /step channel closed/
                );
            },
        },
    };
    const lifecycles = Object.entries(LIFECYCLES);

    const secretPaths = (pair: BoardJob) => [`${secretsBase}/${secretName(pair)}`];
    const jobDeletes = (calls: Call[], jobName: string) =>
        calls.flatMap((call, at) =>
            call.method === 'DELETE' && call.path.startsWith(`${jobPath(namespace, jobName)}?`) ? [at] : []
        );
    const posted = (calls: Call[], jobName: string) =>
        calls.findIndex(
            (call) =>
                call.method === 'POST' &&
                call.path === jobsPath(namespace) &&
                (call.body as { metadata?: { name?: string } }).metadata?.name === jobName
        );
    const claimDeleted = (calls: Call[]) =>
        calls.some((call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id));
    const suspended = (calls: Call[], jobName: string) =>
        calls.some(
            (call) =>
                call.method === 'PATCH' &&
                call.path === jobPath(namespace, jobName) &&
                (call.body as { spec?: { suspend?: boolean } } | undefined)?.spec?.suspend === true
        );

    it.each(lifecycles)('%s: deletes both Secrets before the Job, then gives the claim back', async (_n, life) => {
        const { request, calls } = clusterOf(life, {});
        await life.drive(request);

        const after = posted(calls, life.jobName);
        const deletes = jobDeletes(calls, life.jobName).filter((at) => at > after);
        expect(deletes).toHaveLength(1);
        for (const path of secretPaths(life.pair)) {
            const at = calls.findIndex((call, i) => i > after && call.method === 'DELETE' && call.path === path);
            expect(at).toBeGreaterThan(after);
            expect(at).toBeLessThan(deletes[0]!);
        }
        expect(claimDeleted(calls)).toBe(true);
    });

    it.each(lifecycles)(
        '%s: a refused Secret delete suspends the Job, never deletes it, and keeps the claim',
        async (_n, life) => {
            const { request, calls } = clusterOf(life, {
                secret: (name) => (name === secretName(life.pair) ? 'refused' : null),
            });
            await life.drive(request);

            const after = posted(calls, life.jobName);
            expect(jobDeletes(calls, life.jobName).filter((at) => at > after)).toEqual([]);
            expect(suspended(calls, life.jobName)).toBe(true);
            expect(claimDeleted(calls)).toBe(false);
            expect(JSON.parse((await request('GET', claimPathFor(repoJob.id))).body)).toMatchObject({
                data: { holder: repoJob.leaseToken },
            });
        }
    );

    it.each(lifecycles)('%s: Secrets deleted but the Job delete refused is held, the claim kept', async (_n, life) => {
        const { request, calls } = clusterOf(life, { jobDelete: 'refused' });
        await life.drive(request);

        expect(jobDeletes(calls, life.jobName).length).toBeGreaterThan(0);
        expect(suspended(calls, life.jobName)).toBe(false);
        expect(claimDeleted(calls)).toBe(false);
    });

    it.each(lifecycles)(
        '%s: a Job still read through the bound after its delete is held, the claim kept',
        async (_n, life) => {
            const { request, calls } = clusterOf(life, { jobLingers: true });
            await life.drive(request);
            expect(claimDeleted(calls)).toBe(false);
        }
    );

    it.each(lifecycles)(
        '%s: a writer pod still listed after the Job is gone is held, the claim kept',
        async (_n, life) => {
            const { request, calls } = clusterOf(life, { writerPods: [{ metadata: { name: 'a-gate-pod' } }] });
            await life.drive(request);

            // The confirmation asked for this attempt's writer pods by equality: every pod of the pair.
            expect(
                calls.some(
                    (call) =>
                        call.method === 'GET' &&
                        decodeURIComponent(call.path).endsWith(
                            `labelSelector=factory.job=${life.pair.id},factory.lease=${life.pair.leaseToken}`
                        )
                )
            ).toBe(true);
            expect(claimDeleted(calls)).toBe(false);
        }
    );

    it.each(lifecycles)('%s: a transport throw on the Secret delete leaves the Job listed', async (_n, life) => {
        const { request, calls } = clusterOf(life, {
            secret: (name) => (name === secretName(life.pair) ? 'throws' : null),
        });
        await life.drive(request);

        const after = posted(calls, life.jobName);
        expect(jobDeletes(calls, life.jobName).filter((at) => at > after)).toEqual([]);
        expect(suspended(calls, life.jobName)).toBe(true);
        expect(claimDeleted(calls)).toBe(false);
    });

    // A declared service pod mounts no worktree: it never holds the group's end, whatever its lease.
    // A kill whose Secret delete is refused leaves the Job suspended and listed, its supervisor
    // reporting nothing: the run still ends as the kill's at its very next poll.
    it('ends a run as killed within one poll when its kill could not delete the Job', async () => {
        const { request } = cluster(runnerJobName(repoJob), {
            secret: (name) => (name === secretName(repoJob) ? 'refused' : null),
            jobLingers: true,
        });
        let pollsAfterKill = 0;
        let killed = false;
        // Each poll yields to the timers, so the kill below gets its turn while the run polls.
        const sleep = async () => {
            if (killed) pollsAfterKill += 1;
            if (pollsAfterKill > 1) throw new Error('the run polled on past its kill');
            await new Promise((resolve) => setImmediate(resolve));
        };
        const r = supervisedRunner(config, request, sleep, { steps: fakeSteps().sink, endpoint });
        await r.syncCheckout(repoJob, undefined, SESSION_OF);
        const running = r.run(repoJob, SESSION_OF);
        await new Promise((resolve) => setTimeout(resolve, 5));
        await r.kill(repoJob);
        killed = true;
        expect(await running).toMatchObject({ exitCode: 137, started: true });
        expect(pollsAfterKill).toBeLessThanOrEqual(1);
    });
});

/*
 * Issue #821, round 4: the checkout claim is released only once its group's end is confirmed —
 * through every lifecycle that outlives the agent (the run, its post-run steps, `finish`), a reclaim
 * retried under the same holder, an orphaned claim's reap, the fence's sweep and a post-create
 * stand-down.
 */
describe('claims of an unconfirmed group (#821)', () => {
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/bellows' };
    const SESSION_OF = { id: SESSION, resume: false };
    const secretsBase = `/api/v1/namespaces/${namespace}/secrets`;
    const endpoint = {
        open: async () => ({ url: 'http://driver:8130', token: 'reclaim-token' }),
        close: () => undefined,
    };
    const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' });
    const build = (request: K8sRequest, steps = fakeSteps()) =>
        supervisedRunner(config, request, async () => {}, { steps: steps.sink, endpoint });
    const claimDeletes = (calls: Call[]) =>
        calls.filter((call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id));
    const holderOf = async (request: K8sRequest) =>
        JSON.parse((await request('GET', claimPathFor(repoJob.id))).body)?.data?.holder as string | undefined;

    // F1: the run, a post-run step (the probe) and the finish all ride one group; a finish whose
    // teardown is refused keeps the claim, and nothing earlier in the lifecycle gave it back.
    it('keeps the claim through run → post-run step → a refused finish', async () => {
        let refuse = false;
        const { request, calls } = routed((method, path) =>
            refuse && method === 'DELETE' && path === `${secretsBase}/${secretName(repoJob)}`
                ? { status: 500, body: 'unavailable' }
                : undefined
        );
        const r = build(request);
        await r.syncCheckout(repoJob, undefined, SESSION_OF);
        await r.run(repoJob, SESSION_OF);
        expect(claimDeletes(calls)).toEqual([]);
        await r.probeTree(repoJob);
        expect(claimDeletes(calls)).toEqual([]);
        // The loop's hand-back while the group is live keeps it for the group's end.
        await r.releaseFence!(repoJob);
        expect(claimDeletes(calls)).toEqual([]);
        refuse = true;
        await r.finish(repoJob);
        expect(claimDeletes(calls)).toEqual([]);
        expect(await holderOf(request)).toBe(repoJob.leaseToken);
        // A later hand-back still finds the group unconfirmed: the claim stays.
        await r.releaseFence!(repoJob);
        expect(claimDeletes(calls)).toEqual([]);
    });

    // F1: an agentless attempt's group, created on demand by its first step, gives the claim back
    // at its finish — never right after it was created.
    it('keeps the claim an on-demand group took until that group is finished', async () => {
        const { request, calls } = fakeRequest();
        const r = build(request);
        await r.probeTree(repoJob);
        expect(claimDeletes(calls)).toEqual([]);
        expect(await holderOf(request)).toBe(repoJob.leaseToken);
        await r.finish(repoJob);
        expect(claimDeletes(calls)).toHaveLength(1);
    });

    // Step 7: the fence's sweep deletes a leftover lease's Secrets, acknowledged, before its Job;
    // a refused one deletes nothing that round and leaves the Job listed for the next.
    it("sweeps a leftover lease's Secrets before its Job, and a refused one leaves the Job for the next round", async () => {
        const OLD = '55555555-5555-4555-8555-555555555555';
        const old = { ...repoJob, leaseToken: OLD };
        const leftover = {
            metadata: {
                name: runnerJobName(old),
                uid: `uid-${runnerJobName(old)}`,
                labels: { 'factory.job': repoJob.id, 'factory.lease': OLD },
            },
        };
        let listed = [leftover];
        let refusals = 1;
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return { status: 200, body: JSON.stringify({ items: listed }) };
            }
            if (method === 'DELETE' && path === `${secretsBase}/${secretName(old)}` && refusals > 0) {
                refusals -= 1;
                return { status: 500, body: 'unavailable' };
            }
            if (method === 'DELETE' && path.startsWith(`${jobPath(namespace, runnerJobName(old))}?`)) {
                listed = [];
                return { status: 200, body: '{}' };
            }
        });

        await build(request).syncCheckout(repoJob, undefined, SESSION_OF);

        const deleteOf = (path: string) =>
            calls.flatMap((call, at) => (call.method === 'DELETE' && call.path === path ? [at] : []));
        const runnerSecret = deleteOf(`${secretsBase}/${secretName(old)}`);
        const jobDelete = calls.findIndex(
            (call) => call.method === 'DELETE' && call.path.startsWith(`${jobPath(namespace, runnerJobName(old))}?`)
        );
        // Round one: the refused Secret, nothing else deleted. Round two: the Secret, then the Job.
        expect(runnerSecret).toHaveLength(2);
        expect(jobDelete).toBeGreaterThan(runnerSecret[1]!);
    });

    // F6: a post-create stand-down ends its own Job the acknowledged way; a delete refused there
    // keeps the claim through the sync's cleanup when that is refused too, and the cleanup's
    // confirmed end gives it back.
    it.each([
        ['keeps the claim when the stand-down and the sync cleanup are both refused', 2, false],
        ['gives the claim back once the sync cleanup confirms the stand-down Job ended', 1, true],
    ] as const)('%s', async (_name, refusedDeletes, released) => {
        let left: number = refusedDeletes;
        let claimReads = 0;
        const serve = claimServer();
        const { request, calls } = routed((method, path, body) => {
            if (path === claimPathFor(repoJob.id) && method === 'GET') {
                claimReads += 1;
                // The post-create verify (the third read, after the acquire's and the pre-create
                // verify's) answers the claim taken over.
                if (claimReads === 3) {
                    return {
                        status: 200,
                        body: JSON.stringify({ metadata: { uid: 'x' }, data: { holder: NEW_TOKEN } }),
                    };
                }
            }
            if (method === 'DELETE' && path.startsWith(`${jobPath(namespace, runnerJobName(repoJob))}?`) && left > 0) {
                left -= 1;
                return { status: 500, body: 'unavailable' };
            }
            return serve(method, path, body);
        });

        await expect(build(request).syncCheckout(repoJob, undefined, SESSION_OF)).rejects.toThrow(/stands down/);

        expect(
            calls.filter(
                (call) =>
                    call.method === 'DELETE' && call.path.startsWith(`${jobPath(namespace, runnerJobName(repoJob))}?`)
            )
        ).toHaveLength(2);
        expect(claimDeletes(calls)).toHaveLength(released ? 1 : 0);
    });

    // Step 7: adoption deletes the earlier attempt's Secrets, acknowledged, and keeps its Job — the
    // sweep spares a finished agent run — for a later claim should this one be lost.
    it("adopts with the earlier attempt's Secrets deleted and its Job kept", async () => {
        const adopter: BoardJob = { ...job, leaseToken: NEW_TOKEN, attempts: 2, claimSeq: 2 };
        const prior = {
            metadata: {
                name: runnerJobName(job),
                uid: `uid-${runnerJobName(job)}`,
                labels: { 'factory.job': job.id, 'factory.lease': job.leaseToken },
                annotations: {
                    'factory.claim-seq': '1',
                    'factory.session': SESSION,
                    'factory.command': commandMark(job.command),
                },
            },
            spec: { template: { spec: { containers: [{ name: SUPERVISOR_CONTAINER }, { name: AGENT_CONTAINER }] } } },
            status: { startTime: START, succeeded: 1 },
        };
        let listed: unknown[] = [prior];
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return { status: 200, body: JSON.stringify({ items: listed }) };
            }
            if (method === 'DELETE' && path.startsWith(`${jobPath(namespace, runnerJobName(job))}?`)) {
                listed = [];
                return { status: 200, body: '{}' };
            }
        });

        expect(await runner(request).adopt(adopter)).toMatchObject({ claimSeq: 1 });

        const jobDelete = calls.findIndex(
            (call) => call.method === 'DELETE' && call.path.startsWith(`${jobPath(namespace, runnerJobName(job))}?`)
        );
        const secretDeletes = calls.flatMap((call, at) =>
            call.method === 'DELETE' && call.path.startsWith(`${secretsBase}/`) ? [at] : []
        );
        expect(secretDeletes.map((at) => calls[at]!.path)).toEqual([`${secretsBase}/${secretName(job)}`]);
        expect(jobDelete).toBe(-1);
    });

    // A held kill leaves a suspended Job: never a finished run for the next claim to adopt.
    it('adopts no runner Job its driver suspended', async () => {
        const adopter: BoardJob = { ...job, leaseToken: NEW_TOKEN, attempts: 2, claimSeq: 2 };
        const prior = {
            metadata: {
                name: runnerJobName(job),
                uid: `uid-${runnerJobName(job)}`,
                labels: { 'factory.job': job.id, 'factory.lease': job.leaseToken },
                annotations: {
                    'factory.claim-seq': '1',
                    'factory.session': SESSION,
                    'factory.command': commandMark(job.command),
                },
            },
            spec: {
                suspend: true,
                template: { spec: { containers: [{ name: SUPERVISOR_CONTAINER }, { name: AGENT_CONTAINER }] } },
            },
            status: { startTime: START, failed: 1 },
        };
        const { request } = routed((method, path) =>
            method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)
                ? { status: 200, body: JSON.stringify({ items: [prior] }) }
                : undefined
        );
        expect(await runner(request).adopt(adopter)).toBeNull();
    });
});

/*
 * Issue #821 follow-up: a group whose Job ended by itself has no writer left, so `finish` confirms
 * its end without deleting it — its Secrets acknowledged, no live writer pod — and gives the claim
 * back, keeping the finished Job for a replacement claim to adopt should this driver be lost
 * before its verdict lands. Only a group that did not end within the bound is deleted.
 */
describe('finishing a group that ended by itself (#821)', () => {
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/bellows' };
    const SESSION_OF = { id: SESSION, resume: false };
    const secretsBase = `/api/v1/namespaces/${namespace}/secrets`;
    const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' });
    const build = (request: K8sRequest) => supervisedRunner(config, request, async () => {});
    const runnerAt = jobPath(namespace, runnerJobName(repoJob));
    /** The finished runner Job as the label list answers it, its claim's marks on it. */
    const finished = {
        metadata: {
            name: runnerJobName(repoJob),
            uid: `uid-${runnerJobName(repoJob)}`,
            labels: { 'factory.job': repoJob.id, 'factory.lease': repoJob.leaseToken },
            annotations: {
                'factory.claim-seq': '1',
                'factory.session': SESSION,
                'factory.command': commandMark(repoJob.command),
            },
        },
        spec: { template: { spec: { containers: [{ name: SUPERVISOR_CONTAINER }, { name: AGENT_CONTAINER }] } } },
        status: { startTime: START, succeeded: 1 },
    };
    const writers = (pods: unknown[]) => (method: K8sMethod, path: string) =>
        method === 'GET' && isWriterPodList(path) ? { status: 200, body: JSON.stringify({ items: pods }) } : undefined;
    const jobDeleted = (calls: Call[]) =>
        calls.some((call) => call.method === 'DELETE' && call.path.startsWith(`${runnerAt}?`));
    const claimDeleted = (calls: Call[]) =>
        calls.some((call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id));

    it('keeps the finished Job, deletes its Secrets, gives the claim back, and a replacement claim adopts it', async () => {
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                // The label selector honoured: the attempt's own fence lists every OTHER lease.
                const own = decodeURIComponent(path).includes(`factory.lease!=${repoJob.leaseToken}`);
                return { status: 200, body: JSON.stringify({ items: own || jobDeleted(calls) ? [] : [finished] }) };
            }
        });
        const first = build(request);
        await first.syncCheckout(repoJob, undefined, SESSION_OF);
        await first.finish(repoJob);

        expect(jobDeleted(calls)).toBe(false);
        expect(calls).toContainEqual(
            expect.objectContaining({ method: 'DELETE', path: `${secretsBase}/${secretName(repoJob)}` })
        );
        expect(claimDeleted(calls)).toBe(true);

        // This driver is lost before its verdict: the replacement claim reads the run it left.
        const adopter: BoardJob = { ...repoJob, leaseToken: NEW_TOKEN, attempts: 2, claimSeq: 2 };
        expect(await build(request).adopt(adopter)).toMatchObject({
            claimSeq: 1,
            outcome: { exitCode: 0, started: true, sessionId: SESSION },
        });
    });

    // Issue #821 (D1), the stated limit: a driver whose board took neither the staged conclusion nor
    // the verdict leaves its group and its checkout claim (no `finish`, no release). The next claim
    // takes the stale claim over — an older claim sequence — and adopts the finished run.
    it('takes a never-released claim over from an older attempt, then adopts the group it left', async () => {
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                const own = decodeURIComponent(path).includes(`factory.lease!=${repoJob.leaseToken}`);
                return { status: 200, body: JSON.stringify({ items: own || jobDeleted(calls) ? [] : [finished] }) };
            }
        });
        await build(request).syncCheckout(repoJob, undefined, SESSION_OF);
        const before = await request('GET', claimPathFor(repoJob.id));
        expect(JSON.parse(before.body)).toMatchObject({ data: { holder: repoJob.leaseToken } });

        const adopter: BoardJob = { ...repoJob, leaseToken: NEW_TOKEN, attempts: 2, claimSeq: 2 };
        expect(await build(request).adopt(adopter)).toMatchObject({
            claimSeq: 1,
            outcome: { exitCode: 0, started: true, sessionId: SESSION },
        });

        expect(jobDeleted(calls)).toBe(false);
        const held = await request('GET', claimPathFor(repoJob.id));
        expect(JSON.parse(held.body)).toMatchObject({ data: { holder: NEW_TOKEN } });
    });

    it('counts a finished pod as no writer, and keeps the claim while a live one is listed', async () => {
        const done = { metadata: { name: 'gate-done' }, status: { phase: 'Succeeded' } };
        const live = { metadata: { name: 'gate-live' }, status: { phase: 'Running' } };

        const released = routed(writers([done]));
        const r1 = build(released.request);
        await r1.syncCheckout(repoJob, undefined, SESSION_OF);
        await r1.finish(repoJob);
        expect(claimDeleted(released.calls)).toBe(true);

        const held = routed(writers([done, live]));
        const r2 = build(held.request);
        await r2.syncCheckout(repoJob, undefined, SESSION_OF);
        await r2.finish(repoJob);
        expect(jobDeleted(held.calls)).toBe(false);
        expect(claimDeleted(held.calls)).toBe(false);
    });

    it('deletes the Job of a group that did not end within the bound, Secrets first', async () => {
        const { request, calls } = routed(() => undefined, {
            job: { status: 200, body: JSON.stringify({ metadata: { uid: 'job-uid-1' }, status: {} }) },
        });
        const r = build(request);
        await r.syncCheckout(repoJob, undefined, SESSION_OF);
        await r.finish(repoJob);
        const secretAt = calls.findIndex(
            (call) => call.method === 'DELETE' && call.path === `${secretsBase}/${secretName(repoJob)}`
        );
        const jobAt = calls.findIndex((call) => call.method === 'DELETE' && call.path.startsWith(`${runnerAt}?`));
        expect(secretAt).toBeGreaterThanOrEqual(0);
        expect(jobAt).toBeGreaterThan(secretAt);
    });
});

/*
 * Issue #821 review: a Secret never exists without a Job the fence and the reaper can derive it
 * from — the runner and reclaim Jobs are created suspended, their Secret after, and they are
 * resumed only once the post-create verify holds; and a Job create whose answer was lost is
 * reconciled through the acknowledged teardown before the claim goes back.
 */
describe('a Secret is never without its Job (#821)', () => {
    const secretsBase = `/api/v1/namespaces/${namespace}/secrets`;
    const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' });
    const build = (request: K8sRequest) => supervisedRunner(config, request, async () => {});
    const runnerAt = jobPath(namespace, runnerJobName(job));
    const isRunnerPost = (method: K8sMethod, path: string, body: unknown) =>
        method === 'POST' &&
        path === jobsPath(namespace) &&
        (body as { metadata?: { name?: string } } | undefined)?.metadata?.name === runnerJobName(job);
    const claimDeleted = (calls: Call[]) =>
        calls.some((call) => call.method === 'DELETE' && call.path === claimPathFor(job.id));

    it('creates the runner Job suspended, then its Secret, and resumes it only after the post-create verify', async () => {
        const { request, calls } = fakeRequest();
        await build(request).run(job, { id: SESSION, resume: false });

        const jobPost = calls.findIndex((call) => isRunnerPost(call.method as K8sMethod, call.path, call.body));
        const secretPost = calls.findIndex((call) => call.method === 'POST' && call.path === secretsBase);
        const resume = calls.findIndex(
            (call) =>
                call.method === 'PATCH' &&
                call.path === runnerAt &&
                (call.body as { spec?: { suspend?: boolean } } | undefined)?.spec?.suspend === false
        );
        expect((calls[jobPost]!.body as { spec: { suspend?: boolean } }).spec.suspend).toBe(true);
        expect(secretPost).toBeGreaterThan(jobPost);
        const verify = calls.findIndex(
            (call, at) => at > secretPost && call.method === 'GET' && call.path === claimPathFor(job.id)
        );
        expect(verify).toBeGreaterThan(secretPost);
        expect(resume).toBeGreaterThan(verify);
    });

    it('creates no Secret at all when the runner Job create is rejected', async () => {
        const { request, calls } = routed((method, path, body) =>
            isRunnerPost(method, path, body) ? { status: 422, body: '{"kind":"Status"}' } : undefined
        );
        await expect(build(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(/422/);
        expect(calls.some((call) => call.method === 'POST' && call.path === secretsBase)).toBe(false);
    });

    it.each([
        ['ends the Job whose create answer was lost, Secrets first, before the claim goes back', false],
        ['keeps the claim when the Job whose create answer was lost cannot be deleted', true],
    ] as const)('%s', async (_name, refuseDelete) => {
        const base = fakeRequest();
        const request: K8sRequest = async (method, path, body) => {
            if (isRunnerPost(method, path, body)) {
                // Accepted by the apiserver, the answer lost on the way back.
                await base.request(method, path, body);
                throw new Error('socket hang up');
            }
            if (refuseDelete && method === 'DELETE' && path.startsWith(`${runnerAt}?`)) {
                base.calls.push({ method, path, body });
                return { status: 500, body: 'unavailable' };
            }
            return base.request(method, path, body);
        };
        await expect(build(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(/socket hang up/);

        const jobDelete = base.calls.findIndex(
            (call) => call.method === 'DELETE' && call.path.startsWith(`${runnerAt}?`)
        );
        const secretDelete = base.calls.findIndex(
            (call) => call.method === 'DELETE' && call.path === `${secretsBase}/${secretName(job)}`
        );
        expect(jobDelete).toBeGreaterThanOrEqual(0);
        expect(secretDelete).toBeLessThan(jobDelete);
        expect(claimDeleted(base.calls)).toBe(!refuseDelete);
    });
});

describe('finish retries a teardown left unconfirmed (#821)', () => {
    it('ends a killed group whose Secret delete was refused at the next finish, and only then gives the claim back', async () => {
        const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/bellows' };
        let refusals = 1;
        let groupDeleted = false;
        const groupPath = jobPath(namespace, runnerJobName(repoJob));
        const { request, calls } = routed((method, path) => {
            if (method === 'DELETE' && path.startsWith(`${groupPath}?`)) groupDeleted = true;
            // The held group's Job was suspended, not finished: it reads pending until it is deleted.
            if (method === 'GET' && path === groupPath && !groupDeleted) {
                return { status: 200, body: JSON.stringify({ metadata: { uid: 'job-uid-1' }, status: {} }) };
            }
            if (
                method === 'DELETE' &&
                path === `/api/v1/namespaces/${namespace}/secrets/${secretName(repoJob)}` &&
                refusals > 0
            ) {
                refusals -= 1;
                return { status: 500, body: 'unavailable' };
            }
        });
        const r = supervisedRunner(
            loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' }),
            request,
            async () => {}
        );
        await r.syncCheckout(repoJob, undefined, { id: SESSION, resume: false });
        await r.kill(repoJob);
        const claimDeletes = () =>
            calls.filter((call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id));
        expect(claimDeletes()).toEqual([]);

        // The kill took the group out of memory; the loop's finish still finds the held end.
        await r.finish(repoJob);
        expect(
            calls.some(
                (call) =>
                    call.method === 'DELETE' && call.path.startsWith(`${jobPath(namespace, runnerJobName(repoJob))}?`)
            )
        ).toBe(true);
        expect(claimDeletes()).toHaveLength(1);
    });
});

/*
 * Issue #821 review, round 2: a Secret created after its Job carries an owner reference to that
 * Job's uid, so the API server collects it whatever happens to the Job; and only a Job that ran an
 * agent is a run to adopt — a supervisor-only group's is no evidence, and the adopted run's own
 * Job is kept until the verdict lands.
 */
describe('Secrets owned by their Job, and only agent runs adopted (#821)', () => {
    const secretsBase = `/api/v1/namespaces/${namespace}/secrets`;
    const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' });
    const endpoint = {
        open: async () => ({ url: 'http://driver:8130', token: 'reclaim-token' }),
        close: () => undefined,
    };
    const build = (request: K8sRequest, steps = fakeSteps()) =>
        supervisedRunner(config, request, async () => {}, { steps: steps.sink, endpoint });
    const created = (uid: string) => (method: K8sMethod, path: string) =>
        method === 'POST' && path === jobsPath(namespace)
            ? { status: 201, body: JSON.stringify({ metadata: { uid } }) }
            : undefined;
    const secretPostOf = (calls: Call[]) =>
        calls.find((call) => call.method === 'POST' && call.path === secretsBase)?.body as
            | { metadata: { ownerReferences?: unknown[] } }
            | undefined;

    it("owns the runner Secret by the runner Job's uid", async () => {
        const { request, calls } = routed(created('job-uid-1'));
        await build(request).run(job, { id: SESSION, resume: false });
        expect(secretPostOf(calls)?.metadata.ownerReferences).toEqual([
            { apiVersion: 'batch/v1', kind: 'Job', name: runnerJobName(job), uid: 'job-uid-1' },
        ]);
    });

    it('creates no Secret for a Job whose create answer names no uid, and ends that Job', async () => {
        const { request, calls } = routed((method, path) =>
            method === 'POST' && path === jobsPath(namespace) ? { status: 201, body: '{}' } : undefined
        );
        await expect(build(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(/uid/);
        expect(secretPostOf(calls)).toBeUndefined();
        expect(
            calls.some(
                (call) => call.method === 'DELETE' && call.path.startsWith(`${jobPath(namespace, runnerJobName(job))}?`)
            )
        ).toBe(true);
    });

    it('stands down on a Job create answered 201 null, with no TypeError and both deletes acknowledged', async () => {
        const { request, calls } = routed((method, path) =>
            method === 'POST' && path === jobsPath(namespace) ? { status: 201, body: 'null' } : undefined
        );
        await expect(build(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(/answered no uid/);
        expect(secretPostOf(calls)).toBeUndefined();
        const deletes = calls.filter((call) => call.method === 'DELETE').map((call) => call.path);
        expect(deletes.some((path) => path.startsWith(`${jobPath(namespace, runnerJobName(job))}?`))).toBe(true);
        expect(deletes.some((path) => path.startsWith(secretsBase))).toBe(true);
    });

    const runnerItem = (lease: string, seq: string, containers: string[]) => ({
        metadata: {
            name: runnerJobName({ ...job, leaseToken: lease }),
            uid: `uid-${runnerJobName({ ...job, leaseToken: lease })}`,
            labels: { 'factory.job': job.id, 'factory.lease': lease },
            annotations: {
                'factory.claim-seq': seq,
                'factory.session': SESSION,
                'factory.command': commandMark(job.command),
            },
        },
        spec: { template: { spec: { containers: containers.map((name) => ({ name })) } } },
        status: { startTime: START, succeeded: 1 },
    });
    const AGENT_RUN = [SUPERVISOR_CONTAINER, AGENT_CONTAINER];

    it('never adopts a supervisor-only Job, whatever its claim sequence', async () => {
        let items = [runnerItem(job.leaseToken, '1', AGENT_RUN), runnerItem(NEW_TOKEN, '2', [SUPERVISOR_CONTAINER])];
        const { request } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return { status: 200, body: JSON.stringify({ items }) };
            }
            // The sweep deletes what is no run to keep: the supervisor-only Job goes.
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                items = items.filter((item) => !path.startsWith(jobPath(namespace, item.metadata.name)));
            }
        });
        const third: BoardJob = {
            ...job,
            leaseToken: '77777777-7777-4777-8777-777777777777',
            attempts: 3,
            claimSeq: 3,
        };
        expect(await build(request).adopt(third)).toMatchObject({ claimSeq: 1 });
    });

    it('keeps the adopted run’s Job until the verdict, and finish deletes the supervisor-only group it made', async () => {
        const adopter: BoardJob = {
            ...job,
            repo: 'Bellows-AI/bellows',
            leaseToken: NEW_TOKEN,
            attempts: 2,
            claimSeq: 2,
        };
        const prior = runnerItem(job.leaseToken, '1', AGENT_RUN);
        const priorAt = jobPath(namespace, runnerJobName(job));
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                const gone = calls.some((call) => call.method === 'DELETE' && call.path.startsWith(`${priorAt}?`));
                return { status: 200, body: JSON.stringify({ items: gone ? [] : [prior] }) };
            }
        });
        const r = build(request);
        expect(await r.adopt(adopter)).toMatchObject({ claimSeq: 1 });
        // The post-adoption step runs in a supervisor-only group, which finish ends.
        await r.probeTree(adopter);
        await r.finish(adopter);

        expect(calls.some((call) => call.method === 'DELETE' && call.path.startsWith(`${priorAt}?`))).toBe(false);
        expect(
            calls.some(
                (call) =>
                    call.method === 'DELETE' && call.path.startsWith(`${jobPath(namespace, runnerJobName(adopter))}?`)
            )
        ).toBe(true);
        // Lost before its verdict: the next claim adopts the original run again.
        const third: BoardJob = {
            ...adopter,
            leaseToken: '77777777-7777-4777-8777-777777777777',
            attempts: 3,
            claimSeq: 3,
        };
        expect(await build(request).adopt(third)).toMatchObject({ claimSeq: 1, outcome: { sessionId: SESSION } });
    });
});

/*
 * Issue #821 review, round 3: a finished agent run is kept only for the claim that adopted it and
 * continues its outcome; any fresh sync sweeps it — acknowledged, before the checkout changes — so
 * no later claim adopts an older outcome onto a tree a fresh run has since moved.
 */
describe('a finished run is kept only for the claim that adopted it (#821)', () => {
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/bellows', leaseToken: NEW_TOKEN, attempts: 2, claimSeq: 2 };
    const OLD = job.leaseToken;
    const oldName = runnerJobName({ ...job, leaseToken: OLD });
    const oldAt = jobPath(namespace, oldName);
    const finishedOld = {
        metadata: {
            name: oldName,
            uid: `uid-${oldName}`,
            labels: { 'factory.job': job.id, 'factory.lease': OLD },
            annotations: {
                'factory.claim-seq': '1',
                'factory.session': SESSION,
                'factory.command': commandMark(job.command),
            },
        },
        spec: { template: { spec: { containers: [{ name: SUPERVISOR_CONTAINER }, { name: AGENT_CONTAINER }] } } },
        status: { startTime: START, succeeded: 1 },
    };
    const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' });
    const harness = (refuseDelete: boolean) => {
        let listed = [finishedOld];
        let syncAt = -1;
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return { status: 200, body: JSON.stringify({ items: listed }) };
            }
            if (method === 'DELETE' && path.startsWith(`${oldAt}?`)) {
                if (refuseDelete) return { status: 500, body: 'unavailable' };
                listed = [];
                return { status: 200, body: '{}' };
            }
        });
        const steps = fakeSteps((step) => {
            if (step.kind === 'sync' && syncAt < 0) syncAt = calls.length;
            return stepOk(step.kind === 'sync' ? '{"ok":true,"reason":null}\n' : '');
        });
        const r = supervisedRunner(config, request, async () => {}, { steps: steps.sink });
        return { r, calls, steps, syncAt: () => syncAt };
    };

    it("sweeps an earlier claim's finished run before a fresh sync touches the checkout", async () => {
        const { r, calls, syncAt } = harness(false);
        // The run is not this claim's to adopt (its command was edited since): a fresh sync follows.
        expect(await r.adopt({ ...repoJob, command: 'an edited command' })).toBeNull();
        expect((await r.syncCheckout(repoJob, undefined, { id: SESSION, resume: false })).ok).toBe(true);

        const deleted = calls.findIndex((call) => call.method === 'DELETE' && call.path.startsWith(`${oldAt}?`));
        expect(deleted).toBeGreaterThanOrEqual(0);
        expect(syncAt()).toBeGreaterThan(deleted);
    });

    // #869: the sweep spares the adopted Job only on evidence it is the run it read; a listing that
    // shows that Job without its spec or lease is no evidence, and nothing is deleted on it.
    it.each([
        ['no spec', { ...finishedOld, spec: undefined }],
        [
            'no lease label',
            { ...finishedOld, metadata: { ...finishedOld.metadata, labels: { 'factory.job': job.id } } },
        ],
        ['no status', { ...finishedOld, status: undefined }],
        ['an empty status', { ...finishedOld, status: {} }],
        ['no containers', { ...finishedOld, spec: { template: { spec: { containers: [] } } } }],
    ])('deletes nothing and never syncs when the adopted run is listed with %s', async (_name, listing) => {
        let listed: unknown[] = [finishedOld];
        const { request, calls } = routed((method, path) =>
            method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)
                ? { status: 200, body: JSON.stringify({ items: listed }) }
                : undefined
        );
        const steps = fakeSteps(() => stepOk('{"ok":true,"reason":null}\n'));
        const r = supervisedRunner(config, request, async () => {}, { steps: steps.sink });
        expect(await r.adopt(repoJob)).toMatchObject({ claimSeq: 1 });
        listed = [listing];

        await expect(r.syncCheckout(repoJob, undefined, { id: SESSION, resume: false })).rejects.toThrow();

        expect(calls.some((call) => call.method === 'DELETE' && call.path.startsWith(`${oldAt}?`))).toBe(false);
        expect(steps.submitted.filter((step) => step.kind === 'sync')).toEqual([]);
    });

    // #869: a round whose Job listing proves nothing spares nothing, so it deletes nothing: the
    // adopted run's pod is never swept for want of the Job read that would have spared it.
    it.each([
        ['a 503', { status: 503, body: 'unavailable' }],
        ['an empty object', { status: 200, body: '{}' }],
        ['truncated JSON', { status: 200, body: '{"items":[' }],
        [
            'the adopted Job with an empty status',
            { status: 200, body: JSON.stringify({ items: [{ ...finishedOld, status: {} }] }) },
        ],
    ])('never deletes a pod of the adopted run when the sweep reads the Jobs as %s', async (_name, jobs) => {
        const pod = {
            metadata: {
                name: `${oldName}-pod`,
                uid: `uid-${oldName}-pod`,
                labels: { 'factory.job': job.id, 'factory.lease': OLD, 'job-name': oldName },
            },
        };
        let sweeping = false;
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return sweeping ? jobs : { status: 200, body: JSON.stringify({ items: [finishedOld] }) };
            }
            if (sweeping && method === 'GET' && path.includes('/pods?')) {
                return { status: 200, body: JSON.stringify({ items: [pod] }) };
            }
        });
        const steps = fakeSteps(() => stepOk('{"ok":true,"reason":null}\n'));
        const r = supervisedRunner(config, request, async () => {}, { steps: steps.sink });
        expect(await r.adopt(repoJob)).toMatchObject({ claimSeq: 1 });
        sweeping = true;

        await expect(r.syncCheckout(repoJob, undefined, { id: SESSION, resume: false })).rejects.toThrow();

        expect(calls.some((call) => call.method === 'GET' && call.path.includes('/pods?'))).toBe(true);
        // Nothing of the adopted run — its Job or its pod — is deleted.
        const deleted = calls.filter((call) => call.method === 'DELETE').map((call) => call.path);
        expect(deleted.filter((path) => path.includes(oldName))).toEqual([]);
        expect(steps.submitted.filter((step) => step.kind === 'sync')).toEqual([]);
    });

    // #869: a pod of the kept run is spared by its lease, never by its `job-name` label alone — a
    // pod listed without that label is still the adopted run's; one listed with neither cannot say
    // whose it is, and that round deletes nothing.
    it.each([
        ['its job-name label', { 'factory.job': job.id, 'factory.lease': OLD }],
        ['its job-name or lease label', { 'factory.job': job.id }],
    ])('never deletes a pod of the adopted run listed without %s', async (_name, labels) => {
        const pod = { metadata: { name: `${oldName}-pod`, uid: `uid-${oldName}-pod`, labels } };
        // The leftover pod is listed to the sweep only: the adoption read its run before it.
        let sweeping = false;
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return { status: 200, body: JSON.stringify({ items: [finishedOld] }) };
            }
            if (sweeping && method === 'GET' && path.includes('/pods?')) {
                return { status: 200, body: JSON.stringify({ items: [pod] }) };
            }
        });
        const steps = fakeSteps(() => stepOk('{"ok":true,"reason":null}\n'));
        const r = supervisedRunner(config, request, async () => {}, { steps: steps.sink });
        expect(await r.adopt(repoJob)).toMatchObject({ claimSeq: 1 });
        sweeping = true;

        await r.syncCheckout(repoJob, undefined, { id: SESSION, resume: false }).catch(() => undefined);

        expect(calls.some((call) => call.method === 'GET' && call.path.includes('/pods?'))).toBe(true);
        expect(calls.some((call) => call.method === 'DELETE' && call.path.includes(`/pods/${oldName}-pod`))).toBe(
            false
        );
    });

    it('never syncs while that finished run cannot be deleted', async () => {
        const { r, steps } = harness(true);
        await expect(r.syncCheckout(repoJob, undefined, { id: SESSION, resume: false })).rejects.toThrow();
        expect(steps.submitted.filter((step) => step.kind === 'sync')).toEqual([]);
    });
});

/*
 * Issue #821 review, round 5: a teardown is pending from its first synchronous step, so a
 * concurrent hand-back never releases the claim mid-teardown; a reclaim's teardown names its own
 * incarnation by uid, so a late one never removes the replacement that took the same derived
 * names; and an adoption read is never undone by its finished lease's cleanup.
 */
describe('teardown ownership in time and incarnation (#821)', () => {
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/bellows' };
    const SESSION_OF = { id: SESSION, resume: false };
    const secretsBase = `/api/v1/namespaces/${namespace}/secrets`;
    const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' });
    const claimDeletes = (calls: Call[]) =>
        calls.filter((call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id));
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

    it('keeps the claim through a kill whose Secret delete is still pending, against a concurrent hand-back', async () => {
        let unblock!: () => void;
        const blocked = new Promise<void>((resolve) => {
            unblock = resolve;
        });
        const { request, calls } = routed((method, path) =>
            method === 'DELETE' && path === `${secretsBase}/${secretName(repoJob)}`
                ? blocked.then(() => ({ status: 200, body: '{}' }))
                : undefined
        );
        const r = supervisedRunner(config, request, async () => {});
        await r.syncCheckout(repoJob, undefined, SESSION_OF);
        const killing = r.kill(repoJob);
        await tick();
        await r.releaseFence!(repoJob);
        expect(claimDeletes(calls)).toEqual([]);
        unblock();
        await killing;
        expect(claimDeletes(calls)).toHaveLength(1);
    });

    it('keeps the claim through a finish still waiting on its supervisor, against a concurrent hand-back', async () => {
        let unblock!: () => void;
        const blocked = new Promise<void>((resolve) => {
            unblock = resolve;
        });
        const steps = fakeSteps(async (step) => {
            if (step.kind === 'finish') await blocked;
            return stepOk(step.kind === 'sync' ? '{"ok":true,"reason":null}\n' : '');
        });
        const { request, calls } = fakeRequest();
        const r = supervisedRunner(config, request, async () => {}, { steps: steps.sink });
        await r.syncCheckout(repoJob, undefined, SESSION_OF);
        const finishing = r.finish(repoJob);
        await tick();
        await r.releaseFence!(repoJob);
        expect(claimDeletes(calls)).toEqual([]);
        unblock();
        await finishing;
        expect(claimDeletes(calls)).toHaveLength(1);
    });

    it('answers a read adoption whose finished lease left services whose Secrets cannot be deleted', async () => {
        const adopter: BoardJob = { ...job, leaseToken: NEW_TOKEN, attempts: 2, claimSeq: 2 };
        const prior = {
            metadata: {
                name: runnerJobName(job),
                uid: `uid-${runnerJobName(job)}`,
                labels: { 'factory.job': job.id, 'factory.lease': job.leaseToken },
                annotations: {
                    'factory.claim-seq': '1',
                    'factory.session': SESSION,
                    'factory.command': commandMark(job.command),
                },
            },
            spec: { template: { spec: { containers: [{ name: SUPERVISOR_CONTAINER }, { name: AGENT_CONTAINER }] } } },
            status: { startTime: START, succeeded: 1 },
        };
        let services = [
            {
                metadata: {
                    name: 'factory-svc-left',
                    uid: 'uid-svc-left',
                    labels: { 'factory.job': job.id, 'factory.lease': job.leaseToken },
                },
            },
        ];
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return { status: 200, body: JSON.stringify({ items: [prior] }) };
            }
            if (method === 'GET' && path.startsWith(`/api/v1/namespaces/${namespace}/services?`)) {
                return { status: 200, body: JSON.stringify({ items: services }) };
            }
            if (method === 'DELETE' && path.startsWith(`/api/v1/namespaces/${namespace}/services/`)) {
                services = [];
                return { status: 200, body: '{}' };
            }
            if (method === 'DELETE' && path.startsWith(`${secretsBase}/`)) return { status: 503, body: 'unavailable' };
        });

        expect(await runner(request).adopt(adopter)).toMatchObject({ claimSeq: 1, outcome: { exitCode: 0 } });
        expect(
            calls.some(
                (call) => call.method === 'DELETE' && call.path.startsWith(`${jobPath(namespace, runnerJobName(job))}?`)
            )
        ).toBe(false);
    });

    it('stands an adoption down, never rerunning, when an earlier writer cannot be confirmed gone', async () => {
        const adopter: BoardJob = { ...job, leaseToken: NEW_TOKEN, attempts: 3, claimSeq: 3 };
        const OTHER = '55555555-5555-4555-8555-555555555555';
        const runnerItem = (lease: string, seq: string, status: Record<string, unknown>) => ({
            metadata: {
                name: runnerJobName({ ...job, leaseToken: lease }),
                uid: `uid-${runnerJobName({ ...job, leaseToken: lease })}`,
                labels: { 'factory.job': job.id, 'factory.lease': lease },
                annotations: {
                    'factory.claim-seq': seq,
                    'factory.session': SESSION,
                    'factory.command': commandMark(job.command),
                },
            },
            spec: { template: { spec: { containers: [{ name: SUPERVISOR_CONTAINER }, { name: AGENT_CONTAINER }] } } },
            status: { startTime: START, ...status },
        });
        const items = [runnerItem(job.leaseToken, '1', { succeeded: 1 }), runnerItem(OTHER, '2', { active: 1 })];
        const { request } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return { status: 200, body: JSON.stringify({ items }) };
            }
            if (
                method === 'DELETE' &&
                path.startsWith(`${jobPath(namespace, runnerJobName({ ...job, leaseToken: OTHER }))}?`)
            ) {
                return { status: 503, body: 'unavailable' };
            }
        });
        await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);
    });
});

describe('the sweep deletes the incarnations it listed (#821)', () => {
    it('deletes a leftover Job by its listed uid, its Secrets first', async () => {
        const OLD = '55555555-5555-4555-8555-555555555555';
        const reclaimLeft = 'factory-reclaim-0123456789abcdef';
        let listed = [
            {
                metadata: {
                    name: runnerJobName({ ...job, leaseToken: OLD }),
                    uid: 'old-uid',
                    labels: { 'factory.job': job.id, 'factory.lease': OLD },
                },
            },
            {
                metadata: {
                    name: reclaimLeft,
                    uid: 'reclaim-uid',
                    labels: { 'factory.job': job.id, 'factory.lease': NEW_TOKEN },
                },
            },
        ];
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return { status: 200, body: JSON.stringify({ items: listed }) };
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                listed = listed.filter((item) => !path.startsWith(jobPath(namespace, item.metadata.name)));
                return { status: 200, body: '{}' };
            }
        });
        await runner(request).run(job, { id: SESSION, resume: false });
        const del = (name: string) =>
            calls.find((call) => call.method === 'DELETE' && call.path.startsWith(`${jobPath(namespace, name)}?`));
        expect(del(runnerJobName({ ...job, leaseToken: OLD }))?.body).toMatchObject({
            preconditions: { uid: 'old-uid' },
        });
        expect(del(reclaimLeft)?.body).toMatchObject({ preconditions: { uid: 'reclaim-uid' } });
        const secretsBase = `/api/v1/namespaces/${namespace}/secrets`;
        // A reclaim group's names are its invocation's own (random lease): its Secret goes too.
        expect(
            calls.some(
                (call) =>
                    call.method === 'DELETE' &&
                    call.path === `${secretsBase}/${secretName({ ...job, leaseToken: NEW_TOKEN })}`
            )
        ).toBe(true);
        expect(
            calls.some(
                (call) =>
                    call.method === 'DELETE' &&
                    call.path === `${secretsBase}/${secretName({ ...job, leaseToken: OLD })}`
            )
        ).toBe(true);
    });
});

/*
 * Issue #821 review, round 7: a 409 on a uid precondition means another incarnation now holds the
 * name — never that what blocks the checkout is gone. The sweep lists again, and only a fresh,
 * conclusive empty list lets the sync start.
 */
describe('the sweep proceeds only on a fresh empty list (#821)', () => {
    it('never syncs while a leftover recreated between its list and its delete is still there', async () => {
        const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/bellows' };
        const leftover = {
            metadata: {
                name: 'factory-reclaim-0123456789abcdef',
                uid: 'listed-uid',
                labels: { 'factory.job': job.id, 'factory.lease': NEW_TOKEN },
            },
        };
        const { request } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                // Recreated each time it is deleted: the list keeps answering an incarnation.
                return { status: 200, body: JSON.stringify({ items: [leftover] }) };
            }
            if (method === 'DELETE' && path.startsWith(`${jobPath(namespace, leftover.metadata.name)}?`)) {
                return { status: 409, body: '{"reason":"Conflict"}' };
            }
        });
        const steps = fakeSteps();
        const r = supervisedRunner(
            loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' }),
            request,
            async () => {},
            { steps: steps.sink }
        );
        await expect(r.syncCheckout(repoJob, undefined, { id: SESSION, resume: false })).rejects.toThrow();
        expect(steps.submitted.filter((step) => step.kind === 'sync')).toEqual([]);
    });
});

/*
 * Issue #821 review, round 8: `ended` comes only from the writer-pod confirmation — a Job gone
 * with a pod of it still live is no end — and every mutation of a created Job names its uid.
 */
describe('one end, one identity (#821)', () => {
    it('resumes the runner Job by the uid its create answered', async () => {
        const { request, calls } = fakeRequest();
        await runner(request).run(job, { id: SESSION, resume: false });
        const resume = calls.find(
            (call) =>
                call.method === 'PATCH' &&
                call.path === jobPath(namespace, runnerJobName(job)) &&
                (call.body as { spec?: { suspend?: boolean } }).spec?.suspend === false
        );
        expect(resume?.body).toEqual({ metadata: { uid: 'job-uid-1' }, spec: { suspend: false } });
    });
});
