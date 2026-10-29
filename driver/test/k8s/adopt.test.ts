import { describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../../src/board/board.js';
import { loadDriverConfig } from '../../src/config.js';
import {
    AGENT_CONTAINER,
    SUPERVISOR_CONTAINER,
    SUPERVISOR_EXIT,
    SUPERVISOR_REPORT_PREFIX,
    SUPERVISOR_WINDDOWN_MS,
} from '../../src/supervisor-contract.js';
import { drive, stubBoard } from '../fixtures/loop-stubs.js';
import { AdoptionBlocked, ARTIFACT_LIMIT, commandMark, type AdoptedRun } from '../../src/runner.js';
import type { K8sMethod, K8sRequest, K8sResponse } from '../../src/k8s/k8s-transport.js';
import { LOG_TAIL_LINES } from '../../src/k8s/k8s-transport.js';
import { finalizeWaitMs } from '../../src/supervisor-plan.js';
import { jobsPath, runnerJobName, secretName } from '../../src/k8s/k8s-podspec.js';
import { jobPath } from '../../src/k8s/k8s-auxspec.js';
import { createKubernetesReaper } from '../../src/k8s/k8s-reaper.js';
import { throughTransport } from '../fixtures/k8s-transport-bridge.js';
import type { Call } from '../fixtures/k8s-apiserver.js';
import {
    job,
    SESSION,
    spec,
    namespace,
    podName,
    routed,
    runner,
    NEW_TOKEN,
    START,
    configmapsPath,
    claimPathFor,
    isAgentLogRead,
    kubeletLog,
    numberedLines,
} from '../fixtures/k8s-suite.js';

/*
 * Issue #792: a runner that outlived its driver. The claim that superseded it finds it by the job
 * label, and a FINISHED one is read — verdict, log, session — before anything of it is deleted;
 * the run is never redone. A runner still running, or one the platform took away, is not adopted.
 */
describe('adopting a finished runner of an earlier claim (#792)', () => {
    const adopter: BoardJob = { ...job, leaseToken: NEW_TOKEN, attempts: 2, claimSeq: 2 };
    const priorName = runnerJobName(job);
    const OTHER_LEASE = '66666666-6666-4666-8666-666666666666';
    const priorItem = (status: Record<string, unknown>, seq = '1', name = priorName, lease = job.leaseToken) => ({
        metadata: {
            name,
            uid: `uid-${name}`,
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

    const nameOf = (item: unknown): string => (item as { metadata: { name: string } }).metadata.name;
    /** A fake whose runner-Job listing answers `items`, each until its Job is deleted. */
    const withRunners = (items: unknown[], overrides: Record<string, unknown> = {}) => {
        let listed = items;
        return routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return { status: 200, body: JSON.stringify({ items: listed }) };
            }
            const name =
                method === 'DELETE' ? listed.map(nameOf).find((n) => path.startsWith(jobPath(namespace, n))) : null;
            if (name) {
                listed = listed.filter((item) => nameOf(item) !== name);
                return { status: 200, body: '{}' };
            }
        }, overrides);
    };

    // The adopted run's Job is kept (issue #821): if this claim is lost before its verdict lands, the
    // next claim adopts the same run again; its Secrets go once it is read.
    it('reads its verdict, log and session, keeps its Job for the next claim, and holds the checkout', async () => {
        const { request, calls } = withRunners([priorItem({ succeeded: 1 })]);

        const adopted = await runner(request).adopt(adopter);

        expect(adopted).toMatchObject({
            claimSeq: 1,
            outcome: { exitCode: 0, started: true, timedOut: false, sessionId: SESSION },
        });
        expect((adopted as AdoptedRun).outcome.output).toContain('did the work');
        const logRead = calls.findIndex((call) =>
            call.path.startsWith(`/api/v1/namespaces/${namespace}/pods/${podName}/log`)
        );
        const deleted = calls.findIndex(
            (call) => call.method === 'DELETE' && call.path.startsWith(jobPath(namespace, priorName))
        );
        const secretGone = calls.findIndex(
            (call) =>
                call.method === 'DELETE' && call.path === `/api/v1/namespaces/${namespace}/secrets/${secretName(job)}`
        );
        expect(logRead).toBeGreaterThanOrEqual(0);
        expect(deleted).toBe(-1);
        expect(secretGone).toBeGreaterThan(logRead);
        // The ended group has no supervisor to answer a step: its close-time readout is a reader Job.
        expect(calls.filter((call) => call.method === 'POST' && call.path === jobsPath(namespace))).toHaveLength(1);
        const held = await request('GET', claimPathFor(job.id));
        expect(JSON.parse(held.body)).toMatchObject({ data: { holder: NEW_TOKEN } });
    });

    // Once its read succeeded the run is this attempt's (issue #821): a Secret delete refused
    // after it is cleanup for later — the Job stays as its anchor, the claim stays held, nothing
    // is run again; the reaper's Secret-first pass (or the owner reference) takes the Secret.
    it('answers the read run when its Secret cannot be deleted, keeping the Job as the cleanup anchor', async () => {
        const { request: base, calls } = withRunners([priorItem({ succeeded: 1 })]);
        const secretPath = `/api/v1/namespaces/${namespace}/secrets/${secretName(job)}`;
        let refusals = 1;
        const request: K8sRequest = (method, path, body) => {
            if (method === 'DELETE' && path === secretPath && refusals > 0) {
                refusals -= 1;
                calls.push({ method, path, body });
                return Promise.resolve({ status: 503, body: 'unavailable' });
            }
            return base(method, path, body);
        };

        expect(await runner(request).adopt(adopter)).toMatchObject({ claimSeq: 1, outcome: { exitCode: 0 } });

        expect(
            calls.some((call) => call.method === 'DELETE' && call.path.startsWith(jobPath(namespace, priorName)))
        ).toBe(false);
        const held = await request('GET', claimPathFor(job.id));
        expect(JSON.parse(held.body)).toMatchObject({ data: { holder: NEW_TOKEN } });
        // The Job is still listed: the reaper's pass over the job once it is gone takes the Secret first.
        const removed = await createKubernetesReaper({
            config: loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }),
            request,
            sleep: async () => {},
        }).reap(
            { jobId: job.id, leaseToken: job.leaseToken, createdAtMs: 0, objects: [{ kind: 'job', name: priorName }] },
            'gone'
        );
        expect(removed).toContain(`secret ${secretName(job)}`);
    });

    it('adopts the newest of two finished runners by claim sequence', async () => {
        const OLDER = '55555555-5555-4555-8555-555555555555';
        const { request } = withRunners([
            priorItem({ succeeded: 1 }, '3'),
            priorItem({ succeeded: 1 }, '1', runnerJobName({ ...job, leaseToken: OLDER }), OLDER),
        ]);

        expect((await runner(request).adopt({ ...adopter, claimSeq: 4 }))?.claimSeq).toBe(3);
    });

    it("adopts the earlier runner's whole log, not a line tail (#825)", async () => {
        const whole = numberedLines(LOG_TAIL_LINES + 500);
        const { request: base } = withRunners([priorItem({ succeeded: 1 })]);
        const request: K8sRequest = (method, path, body) =>
            method === 'GET' && isAgentLogRead(path)
                ? Promise.resolve(kubeletLog(whole)(path))
                : base(method, path, body);

        const adopted = await runner(request).adopt(adopter);

        expect((adopted as AdoptedRun | null)?.outcome).toMatchObject({ fullLog: whole, logTruncated: false });
    });

    // Failure injection at the transport boundary: a runner-Job list too big for a log's stream
    // buffer is still one whole answer — never a cut body that parses as "no earlier runner".
    it('adopts the earlier runner when its Job list outgrows a pod log stream buffer (#825)', async () => {
        const OLDER = '55555555-5555-4555-8555-555555555555';
        const HEAD_PAD = 1_000;
        const padded = (item: ReturnType<typeof priorItem>, pad: number) => ({
            ...item,
            metadata: { ...item.metadata, annotations: { ...item.metadata.annotations, pad: 'p'.repeat(pad) } },
        });
        // A body cut to its head and tail would read the finished runner's name and claim sequence
        // with the still-running older runner's status — a runner never adopted.
        const { request } = withRunners([
            padded(priorItem({ succeeded: 1 }), HEAD_PAD),
            padded(priorItem({ active: 1 }, '0', runnerJobName({ ...job, leaseToken: OLDER }), OLDER), ARTIFACT_LIMIT),
        ]);

        const adopted = await runner(throughTransport(request)).adopt(adopter);

        expect(adopted?.claimSeq).toBe(1);
    });

    // A runner marked at or after this claim's sequence is a newer contender's, never an earlier one.
    it('never adopts a runner of a claim at or after its own', async () => {
        const { request } = withRunners([priorItem({ succeeded: 1 }, '2')]);
        expect(await runner(request).adopt(adopter)).toBeNull();
    });

    it('never adopts a runner that is still running, and deletes nothing', async () => {
        // The agent is running, as the pod of a run that has not ended says (the default pod list shows it exited).
        const { request, calls } = withRunners([priorItem({ active: 1 })], {
            pods: runnerPods({ running: {} }, { running: {} }),
        });

        expect(await runner(request).adopt(adopter)).toBeNull();
        expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
        expect(calls.some((call) => call.method === 'POST' && call.path === configmapsPath)).toBe(false);
    });

    it('never adopts a runner the platform took away, leaving it to the launch sweep', async () => {
        const { request, calls } = withRunners([priorItem({ failed: 1 })], {
            job: jobAnswer({ failed: 1 }),
            pods: {
                status: 200,
                body: JSON.stringify({
                    // Deleted under the run: its containers killed, the pod over.
                    items: [
                        {
                            metadata: { name: podName, deletionTimestamp: '2026-01-01T00:00:00Z' },
                            status: { phase: 'Failed' },
                        },
                    ],
                }),
            },
        });

        expect(await runner(request).adopt(adopter)).toBeNull();
        expect(
            calls.some((call) => call.method === 'DELETE' && call.path.startsWith(jobPath(namespace, priorName)))
        ).toBe(false);
        const held = await request('GET', claimPathFor(job.id));
        expect(held.status).toBe(404);
    });

    // A regression guard: the group's agent never ran, so its completed-looking end is no run to adopt.
    it('never adopts a group whose supervisor lost its driver before the agent was released', async () => {
        const { request, calls } = withRunners([priorItem({ failed: 1 })], {
            job: jobAnswer({ failed: 1 }),
            pods: {
                status: 200,
                body: JSON.stringify({
                    items: [
                        {
                            metadata: { name: podName },
                            status: {
                                phase: 'Failed',
                                containerStatuses: [
                                    { name: 'agent', state: { terminated: { exitCode: 0 } } },
                                    { name: 'supervisor', state: { terminated: { exitCode: SUPERVISOR_EXIT.lost } } },
                                ],
                            },
                        },
                    ],
                }),
            },
        });

        expect(await runner(request).adopt(adopter)).toBeNull();
        expect(
            calls.some((call) => call.method === 'DELETE' && call.path.startsWith(jobPath(namespace, priorName)))
        ).toBe(false);
        expect((await request('GET', claimPathFor(job.id))).status).toBe(404);
    });

    // BEL-127: a node-killed pod keeps ContainerStatusUnknown statuses whose times are null; that is a
    // readable pod, never a shape refusal that blocks the adoption.
    it('takes away, rather than blocks on, a killed pod whose container times are null', async () => {
        const unknown = {
            terminated: { exitCode: 137, reason: 'ContainerStatusUnknown', startedAt: null, finishedAt: null },
        };
        const { request, calls } = withRunners([priorItem({ failed: 1 })], {
            job: jobAnswer({ failed: 1 }),
            pods: {
                status: 200,
                body: JSON.stringify({
                    items: [
                        {
                            metadata: { name: podName, creationTimestamp: null, deletionTimestamp: null },
                            status: {
                                phase: 'Failed',
                                containerStatuses: [
                                    { name: AGENT_CONTAINER, state: unknown },
                                    { name: SUPERVISOR_CONTAINER, state: unknown },
                                ],
                            },
                        },
                    ],
                }),
            },
        });

        const adopted = await runner(request).adopt(adopter);

        // The supervisor's ContainerStatusUnknown end is an infrastructure loss: the earlier run is taken
        // away (given back to the sweep and redone), never adopted as a verdict and never blocked.
        expect(adopted).toBeNull();
        expect(
            calls.some((call) => call.method === 'DELETE' && call.path.startsWith(jobPath(namespace, priorName)))
        ).toBe(false);
        expect((await request('GET', claimPathFor(job.id))).status).toBe(404);
    });

    /** A listed runner Job carrying the reasons its driver recorded for ending it. */
    const recorded = (item: ReturnType<typeof priorItem>, marks: Record<string, string>) => ({
        ...item,
        metadata: { ...item.metadata, annotations: { ...item.metadata.annotations, ...marks } },
    });
    const SPOOL_MARK = { 'factory.kill.artifact_spool_full': '2000000000 bytes' };

    // Why the lost driver ended the run was recorded on its Job before the stop: the adoption reads
    // the verdict the attached run would have.
    it('adopts a supervised stop its lost driver recorded for a full spool, with the spool fault', async () => {
        const { request } = withRunners([recorded(priorItem({ succeeded: 1 }), SPOOL_MARK)]);

        const adopted = await runner(request).adopt(adopter);

        expect((adopted as AdoptedRun | null)?.outcome.artifactSpoolFull).toBe('2000000000 bytes');
        expect((adopted as AdoptedRun | null)?.outcome).not.toHaveProperty('infraLoss');
    });

    // A full spool rides a supervised stop: its record never explains a supervisor lost after it.
    it('never takes a recorded full spool for the end of a supervisor that did not finalize', async () => {
        const { request } = withRunners([recorded(priorItem({ failed: 1 }), SPOOL_MARK)], {
            pods: {
                status: 200,
                body: JSON.stringify({
                    items: [
                        {
                            metadata: { name: podName },
                            status: {
                                phase: 'Failed',
                                containerStatuses: [
                                    { name: 'agent', state: { terminated: { exitCode: 137 } } },
                                    { name: 'supervisor', state: { terminated: { exitCode: 70 } } },
                                ],
                            },
                        },
                    ],
                }),
            },
        });

        expect(await runner(request).adopt(adopter)).toBeNull();
    });

    // Stated limit: a stop that fell back to the hard kill deleted the Job, its record with it —
    // nothing is left to adopt, and the job runs again with its checkout and session.
    it('finds nothing to adopt after the hard kill deleted a recorded runner', async () => {
        const { request, calls } = withRunners([recorded(priorItem({ active: 1 }), SPOOL_MARK)]);
        const lost = runner(request);
        await lost.recordKill(job, { reason: 'artifact_spool_full', detail: '2000000000 bytes' });
        await lost.kill(job);

        expect(
            calls.some((call) => call.method === 'DELETE' && call.path.startsWith(jobPath(namespace, priorName)))
        ).toBe(true);
        expect(await runner(request).adopt(adopter)).toBeNull();
    });

    // A queued task's command can be edited after a handover: a run of the old command is not its run.
    it('never adopts a run of a command since edited', async () => {
        const { request } = withRunners([priorItem({ succeeded: 1 })]);
        expect(await runner(request).adopt({ ...adopter, command: 'another command' })).toBeNull();
    });

    // Issue #822: the runner of an interrupted attempt finished while its takeover or handover was
    // being claimed. The continuing claim carries the command the first claim ran, so the marks
    // that runner's Job was created with are its own, and the run is adopted, never redone.
    it('adopts, for a claim continuing an interrupted attempt, the runner its first claim launched', async () => {
        const listed = priorItem({ succeeded: 1 });
        const launched = { ...listed, metadata: { ...listed.metadata, annotations: spec().metadata.annotations } };
        const { request } = withRunners([launched]);
        const continuing = { ...adopter, resumeSessionId: SESSION, ownSession: true, continuesInterrupted: true };

        expect(await runner(request).adopt(continuing)).toMatchObject({
            claimSeq: 1,
            outcome: { exitCode: 0, started: true, sessionId: SESSION },
        });
    });

    /*
     * Issue #824 (D13): the agent exited, and the lost driver's supervisor is still finalizing — it
     * drains, reports and ends by itself once its orphan bound passes. The next claim waits that out
     * and adopts the run instead of sweeping it, and reads the final report the supervisor logged.
     */
    const runnerPods = (agent: Record<string, unknown>, supervisor: Record<string, unknown>, metadata = {}) => ({
        status: 200,
        body: JSON.stringify({
            items: [
                {
                    metadata: { name: podName, ...metadata },
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
    const FINALIZING = runnerPods({ terminated: { exitCode: 0 } }, { running: {} });
    const FINALIZED = runnerPods({ terminated: { exitCode: 0 } }, { terminated: { exitCode: 0 } });
    const jobAnswer = (status: Record<string, unknown>): K8sResponse => ({
        status: 200,
        body: JSON.stringify({ metadata: { name: priorName, uid: `uid-${priorName}` }, status }),
    });
    const STILL_FINALIZING = jobAnswer({ active: 1 });
    const reportLog = (report: Record<string, unknown>): K8sResponse => ({
        status: 200,
        body: `serving steps\n${SUPERVISOR_REPORT_PREFIX}${JSON.stringify({
            outcome: 'completed',
            cause: null,
            agentExit: 0,
            agentEnd: 'exit',
            drained: true,
            ...report,
        })}\n`,
    });
    const isSupervisorLogRead = (path: string): boolean =>
        path.startsWith(`/api/v1/namespaces/${namespace}/pods/${podName}/log`) &&
        path.includes(`container=${SUPERVISOR_CONTAINER}`);
    const isRunnerPodList = (path: string): boolean =>
        path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=');
    const isPriorStatusRead = (method: K8sMethod, path: string): boolean =>
        method === 'GET' && path.split('?')[0] === jobPath(namespace, priorName);

    /**
     * withRunners over one earlier runner `item`, whose own status reads answer `statuses` in turn
     * (the last from then on) — a terminal one lands on the listed Job too, as the apiserver lists
     * it — whose supervisor log answers `supervisorLog`, and whose `onPoll` runs on each status read.
     */
    const earlier = ({
        item = priorItem({ active: 1 }),
        statuses = [STILL_FINALIZING],
        // The runner pod as the Job is: its supervisor running until the Job lists over.
        pods = () => ('succeeded' in item.status || 'failed' in item.status ? FINALIZED : FINALIZING),
        supervisorLog,
        onPoll,
    }: {
        item?: ReturnType<typeof priorItem>;
        statuses?: K8sResponse[];
        pods?: K8sResponse | (() => K8sResponse);
        supervisorLog?: K8sResponse | (() => K8sResponse);
        onPoll?: (poll: number, request: K8sRequest) => void | Promise<void>;
    } = {}) => {
        const base = withRunners([item], { pods: typeof pods === 'function' ? FINALIZING : pods });
        let polls = 0;
        const request: K8sRequest = async (method, path, body) => {
            if (typeof pods === 'function' && method === 'GET' && isRunnerPodList(path)) {
                base.calls.push({ method, path, body });
                return pods();
            }
            if (isPriorStatusRead(method, path)) {
                base.calls.push({ method, path, body });
                const answer = statuses[Math.min(polls, statuses.length - 1)]!;
                polls += 1;
                await onPoll?.(polls, request);
                const status =
                    (answer.status === 200 ? (JSON.parse(answer.body) as { status?: object } | null)?.status : null) ??
                    {};
                if ('succeeded' in status || 'failed' in status) item.status = { startTime: START, ...status };
                return answer;
            }
            if (method === 'GET' && supervisorLog && isSupervisorLogRead(path)) {
                base.calls.push({ method, path, body });
                return typeof supervisorLog === 'function' ? supervisorLog() : supervisorLog;
            }
            return base.request(method, path, body);
        };
        const polled = () => base.calls.filter((call) => isPriorStatusRead(call.method as K8sMethod, call.path));
        return { request, calls: base.calls, polled };
    };
    const deletedPrior = (calls: Call[]): boolean =>
        calls.some(
            (call) =>
                call.method === 'DELETE' &&
                (call.path.startsWith(jobPath(namespace, priorName)) ||
                    call.path.endsWith(`/secrets/${secretName(job)}`))
        );
    const claimedAt = (calls: Call[]): number =>
        calls.findIndex((call) => call.method === 'POST' && call.path === configmapsPath);

    it('waits out a supervisor still finalizing after its agent exited, then adopts its run (#824)', async () => {
        const { request, calls, polled } = earlier({
            statuses: [STILL_FINALIZING, STILL_FINALIZING, jobAnswer({ succeeded: 1 })],
        });

        const adopted = await runner(request).adopt(adopter);

        expect(adopted).toMatchObject({ claimSeq: 1, outcome: { exitCode: 0, started: true, sessionId: SESSION } });
        expect(polled()).toHaveLength(3);
        // The claim is taken before the wait: no other contender reads or sweeps the group alongside.
        expect(claimedAt(calls)).toBeGreaterThanOrEqual(0);
        expect(calls.indexOf(polled()[0]!)).toBeGreaterThan(claimedAt(calls));
        expect(
            calls.some((call) => call.method === 'DELETE' && call.path.startsWith(jobPath(namespace, priorName)))
        ).toBe(false);
        const held = await request('GET', claimPathFor(job.id));
        expect(JSON.parse(held.body)).toMatchObject({ data: { holder: NEW_TOKEN } });
    });

    // The docker twin's bound: a supervisor that never ends in its own wind-down is no run to adopt.
    it('leaves a supervisor that never finalizes in the bound to the sync’s sweep, its claim given back', async () => {
        const { request, calls, polled } = earlier();

        expect(await runner(request).adopt(adopter)).toBeNull();

        expect(polled().length).toBeGreaterThan(1);
        expect(claimedAt(calls)).toBeGreaterThanOrEqual(0);
        expect(deletedPrior(calls)).toBe(false);
        expect((await request('GET', claimPathFor(job.id))).status).toBe(404);
    });

    // Failure injection: status reads that never answer are no confirmation the supervisor hangs.
    it('stands down, deleting nothing, when the finalizing runner cannot be read to its end', async () => {
        const { request, calls } = earlier({ statuses: [{ status: 503, body: 'unavailable' }] });

        await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(deletedPrior(calls)).toBe(false);
        expect((await request('GET', claimPathFor(job.id))).status).toBe(404);
    });

    // #869: a status read that is no Job's — a corrupt count, no uid to tell the incarnation by — is not "still running".
    it.each([
        ['a corrupt count', jobAnswer({ failed: 'junk' })],
        ['no uid', { status: 200, body: JSON.stringify({ metadata: { name: priorName }, status: { active: 1 } }) }],
        ['no status', { status: 200, body: JSON.stringify({ metadata: { name: priorName, uid: 'u' } }) }],
    ])('stands down, deleting nothing, when the finalizing runner reads with %s', async (_name, answer) => {
        const { request, calls } = earlier({ statuses: [answer] });

        await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(deletedPrior(calls)).toBe(false);
    });

    // An older claim's runner, its discovery fields as given: `seq` its claim sequence, `lease` its lease label.
    const pooledPrior = (seq: string, lease: string = job.leaseToken) =>
        priorItem({ succeeded: 1 }, seq, priorName, lease);

    /** The runner listing's `prior`, its metadata edited: a lease label, or an annotation, replaced or (undefined) removed. */
    const editedPrior = (edit: { lease?: string | null; annotations?: Record<string, string | undefined> }) => {
        const base = pooledPrior('1');
        const labels: Record<string, string> = { ...base.metadata.labels };
        if (edit.lease === null) delete labels['factory.lease'];
        const annotations: Record<string, string | undefined> = { ...base.metadata.annotations, ...edit.annotations };
        for (const key of Object.keys(annotations)) if (annotations[key] === undefined) delete annotations[key];
        return { ...base, metadata: { ...base.metadata, labels, annotations } };
    };

    // A valid command mark that is another command's: that run is not ours (a handover edited the command), not unreadable.
    it('skips a runner whose command mark is another valid mark, claiming nothing', async () => {
        const { request, calls } = earlier();
        const other = editedPrior({ annotations: { 'factory.command': '0123456789abcdef' } });
        const listed: K8sRequest = (method, path, body) =>
            method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)
                ? Promise.resolve({ status: 200, body: JSON.stringify({ items: [other] }) })
                : request(method, path, body);

        expect(await runner(listed).adopt(adopter)).toBeNull();

        expect(claimedAt(calls)).toBe(-1);
        expect(deletedPrior(calls)).toBe(false);
    });

    // Issue #869: an earlier-runner listing with an entry that names nothing is no list to adopt from.
    it.each([
        ['an empty entry', {}],
        ['an entry named by a number', { metadata: { name: 5 } }],
        ['a runner whose claim sequence is corrupt', pooledPrior('corrupt')],
        ['a runner whose claim sequence is empty', pooledPrior('')],
        ['a runner whose claim sequence overflows the safe integers', pooledPrior('9'.repeat(400))],
        ['a runner with no claim sequence', editedPrior({ annotations: { 'factory.claim-seq': undefined } })],
        ['a runner with no lease label', editedPrior({ lease: null })],
        ['a runner whose command mark is unreadable', editedPrior({ annotations: { 'factory.command': 'zz' } })],
        ['a runner with no command mark', editedPrior({ annotations: { 'factory.command': undefined } })],
        ['a runner with no spec', { ...pooledPrior('1'), spec: undefined }],
        [
            'a runner whose container has no name',
            { ...pooledPrior('1'), spec: { template: { spec: { containers: [{}] } } } },
        ],
        ['a runner whose lease label is no lease', pooledPrior('1', 'corrupt')],
        ['a runner whose Job conditions are no list', priorItem({ failed: 1, conditions: 'Failed' })],
    ])('stands down, claiming nothing, when the earlier runners are listed with %s', async (_name, entry) => {
        const { request, calls } = earlier();
        const listed: K8sRequest = (method, path, body) =>
            method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)
                ? Promise.resolve({ status: 200, body: JSON.stringify({ items: [entry] }) })
                : request(method, path, body);

        await expect(runner(listed).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(claimedAt(calls)).toBe(-1);
        expect(deletedPrior(calls)).toBe(false);
    });

    // #869: a runner pod whose phase or container statuses are not what the apiserver writes says nothing of its agent.
    it.each([
        ['a phase that is no string', { phase: 5 }],
        ['container statuses that are no list', { phase: 'Running', containerStatuses: 'x' }],
        ['a container status with no name', { phase: 'Running', containerStatuses: [{ state: { running: {} } }] }],
        [
            'a terminated state with a fractional exit code',
            {
                phase: 'Running',
                containerStatuses: [{ name: AGENT_CONTAINER, state: { terminated: { exitCode: 1.5 } } }],
            },
        ],
        [
            'a state that is no record',
            { phase: 'Running', containerStatuses: [{ name: AGENT_CONTAINER, state: 'terminated' }] },
        ],
        ['conditions that are no list', { phase: 'Running', conditions: 'DisruptionTarget' }],
        ['a condition with no type', { phase: 'Running', conditions: [{ status: 'True' }] }],
    ])('stands down, claiming nothing, when the runner pods are listed with %s', async (_name, status) => {
        const { request, calls } = earlier({
            pods: { status: 200, body: JSON.stringify({ items: [{ metadata: { name: podName }, status }] }) },
        });

        await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(claimedAt(calls)).toBe(-1);
        expect(deletedPrior(calls)).toBe(false);
    });

    // Failure injection: a pod list that cannot be read cannot tell an exited agent from a running one.
    it('stands down, claiming nothing, when it cannot read whether the agent of a running Job ended', async () => {
        const { request, calls } = earlier({ pods: { status: 503, body: 'unavailable' } });

        await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(claimedAt(calls)).toBe(-1);
        expect(deletedPrior(calls)).toBe(false);
    });

    it('takes a runner Job deleted while its supervisor finalized as taken away, its claim given back', async () => {
        const { request, calls } = earlier({
            statuses: [STILL_FINALIZING, { status: 404, body: '{"kind":"Status","reason":"NotFound"}' }],
        });

        expect(await runner(request).adopt(adopter)).toBeNull();

        expect(claimedAt(calls)).toBeGreaterThanOrEqual(0);
        expect((await request('GET', claimPathFor(job.id))).status).toBe(404);
    });

    // A pod being deleted is still the run's: one whose Job has not ended is waited out like any
    // other, and one that never ends in the bound is the sweep's, its claim given back.
    it('waits out a runner whose pod is being deleted while its Job has not ended', async () => {
        const { request, calls } = earlier({
            pods: runnerPods(
                { terminated: { exitCode: 0 } },
                { terminated: { exitCode: 137 } },
                { deletionTimestamp: '2026-01-01T00:00:00Z' }
            ),
        });

        expect(await runner(request).adopt(adopter)).toBeNull();

        expect(claimedAt(calls)).toBeGreaterThanOrEqual(0);
        expect(deletedPrior(calls)).toBe(false);
        expect((await request('GET', claimPathFor(job.id))).status).toBe(404);
    });

    // A Stop or a lost lease mid-wait: the abandoned adoption reads and deletes nothing more.
    it('abandons the wait when the attempt stands down, deleting nothing', async () => {
        const standDown = new AbortController();
        const { request, calls, polled } = earlier({
            onPoll: (poll) => {
                if (poll === 2) standDown.abort();
            },
        });

        await expect(runner(request).adopt(adopter, standDown.signal)).rejects.toThrow(/abandoned/);

        expect(polled()).toHaveLength(2);
        expect(deletedPrior(calls)).toBe(false);
    });

    // A newer claim took the checkout while this one waited: the run is no longer this attempt's.
    it('stands down, deleting nothing, when its claim is taken over while the supervisor finalized', async () => {
        const OTHER = '44444444-4444-4444-8444-444444444444';
        const { request, calls } = earlier({
            statuses: [STILL_FINALIZING, jobAnswer({ succeeded: 1 })],
            onPoll: async (poll, req) => {
                if (poll !== 2) return;
                await req('DELETE', claimPathFor(job.id));
                await req('POST', configmapsPath, {
                    metadata: { name: `factory-job-${job.id}-claim` },
                    data: { holder: OTHER, claimSeq: '3' },
                });
            },
        });

        await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(deletedPrior(calls)).toBe(false);
        const held = await request('GET', claimPathFor(job.id));
        expect(JSON.parse(held.body)).toMatchObject({ data: { holder: OTHER } });
    });

    it('adopts a full spool the supervisor raised itself, from its final report (#824)', async () => {
        const { request } = earlier({
            item: priorItem({ succeeded: 1 }),
            supervisorLog: reportLog({ outcome: 'failed', cause: 'artifact_spool_full', agentEnd: 'killed' }),
        });

        const adopted = await runner(request).adopt(adopter);

        expect((adopted as AdoptedRun | null)?.outcome.artifactSpoolFull).toBe(
            'the supervisor reported the spool full'
        );
        expect((adopted as AdoptedRun | null)?.outcome).not.toHaveProperty('infraLoss');
    });

    // The report is the supervisor's finalization: a crash after it does not unsay it.
    it('adopts a run whose supervisor crashed after logging its final report', async () => {
        const { request } = earlier({
            item: priorItem({ failed: 1 }),
            pods: runnerPods({ terminated: { exitCode: 0 } }, { terminated: { exitCode: 70 } }),
            supervisorLog: reportLog({}),
        });

        expect(await runner(request).adopt(adopter)).toMatchObject({ claimSeq: 1, outcome: { exitCode: 0 } });
    });

    // A group whose driver was lost before it released the agent reports too, and exits 75: no run.
    it('never adopts a group whose logged report says its agent was never launched', async () => {
        const { request } = earlier({
            item: priorItem({ failed: 1 }),
            pods: runnerPods({ terminated: { exitCode: 0 } }, { terminated: { exitCode: SUPERVISOR_EXIT.lost } }),
            supervisorLog: reportLog({
                outcome: 'lost',
                cause: 'driver_lost',
                agentExit: null,
                agentEnd: 'unlaunched',
            }),
        });

        expect(await runner(request).adopt(adopter)).toBeNull();
    });

    // Failure injection: a log the apiserver would not serve is no answer — not "no report", which
    // would make a supervisor that reported and then crashed a loss, and the run swept unread.
    it('stands down, deleting nothing, when the supervisor log cannot be read', async () => {
        const { request, calls } = earlier({
            item: priorItem({ failed: 1 }),
            pods: runnerPods({ terminated: { exitCode: 0 } }, { terminated: { exitCode: 70 } }),
            supervisorLog: { status: 503, body: 'unavailable' },
        });

        await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(deletedPrior(calls)).toBe(false);
    });

    it('reads the supervisor log again after a refusal, and adopts the run it reported', async () => {
        let refusals = 1;
        const { request } = earlier({
            item: priorItem({ failed: 1 }),
            pods: runnerPods({ terminated: { exitCode: 0 } }, { terminated: { exitCode: 70 } }),
            supervisorLog: () => (refusals-- > 0 ? { status: 503, body: 'unavailable' } : reportLog({})),
        });

        expect(await runner(request).adopt(adopter)).toMatchObject({ claimSeq: 1, outcome: { exitCode: 0 } });
    });

    // A Stop during a finished run's close-time read: the abandoned adoption sweeps and deletes nothing.
    it('abandons the adoption of a finished run when the attempt stands down during its read', async () => {
        const standDown = new AbortController();
        const { request: base, calls } = earlier({ item: priorItem({ succeeded: 1 }) });
        const request: K8sRequest = (method, path, body) => {
            if (method === 'GET' && isAgentLogRead(path)) standDown.abort();
            return base(method, path, body);
        };

        await expect(runner(request).adopt(adopter, standDown.signal)).rejects.toThrow(/abandoned/);

        expect(deletedPrior(calls)).toBe(false);
    });

    // #829 S3: a released group's supervisor may wait the takeover grace for a holder before it finalizes.
    it('adopts a run whose supervisor ended past the wind-down, within the takeover grace', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            const { request } = earlier({
                statuses: [STILL_FINALIZING, STILL_FINALIZING, jobAnswer({ succeeded: 1 })],
                onPoll: (poll) => {
                    if (poll === 2) vi.setSystemTime(Date.now() + SUPERVISOR_WINDDOWN_MS + 1_000);
                },
            });

            expect(await runner(request).adopt(adopter)).toMatchObject({ claimSeq: 1, outcome: { exitCode: 0 } });
        } finally {
            vi.useRealTimers();
        }
    });

    // The bound is the finalize wait in time: status reads that each take long end it sooner than polls would.
    it('ends the wait at the finalize-wait deadline however slowly the status reads answer', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            const { request, polled } = earlier({
                onPoll: () => {
                    vi.setSystemTime(Date.now() + 60_000);
                },
            });

            expect(await runner(request).adopt(adopter)).toBeNull();

            expect(polled().length).toBeLessThanOrEqual(
                Math.ceil(
                    finalizeWaitMs(
                        loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' })
                    ) / 60_000
                ) + 1
            );
        } finally {
            vi.useRealTimers();
        }
    });

    // The deadline bounds the reads too: an apiserver that never answers spends the finalize wait, not
    // the verdict reads' own retries on top of every poll.
    it('stands down at the finalize-wait deadline when the status reads never answer', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            const { request, calls, polled } = earlier({
                statuses: [{ status: 503, body: 'unavailable' }],
                onPoll: () => {
                    vi.setSystemTime(Date.now() + 30_000);
                },
            });

            await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

            expect(polled().length).toBeLessThanOrEqual(
                Math.ceil(
                    finalizeWaitMs(
                        loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' })
                    ) / 30_000
                ) + 1
            );
            expect(deletedPrior(calls)).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    // A Stop mid-sweep: the abandoned adoption deletes nothing past the request in flight.
    it('stops deleting the moment the attempt stands down during its sweep', async () => {
        const OLDER = '55555555-5555-4555-8555-555555555555';
        const olderPair = { ...job, leaseToken: OLDER };
        const standDown = new AbortController();
        const { request: base, calls } = withRunners([
            priorItem({ succeeded: 1 }),
            priorItem({ succeeded: 1 }, '0', runnerJobName(olderPair), OLDER),
        ]);
        const request: K8sRequest = (method, path, body) => {
            if (method === 'DELETE' && path.endsWith(`/secrets/${secretName(olderPair)}`)) standDown.abort();
            return base(method, path, body);
        };

        await expect(runner(request).adopt(adopter, standDown.signal)).rejects.toThrow(/abandoned/);

        const deletes = calls.filter((call) => call.method === 'DELETE' && !call.path.startsWith(configmapsPath));
        const aborted = deletes.findIndex((call) => call.path.endsWith(`/secrets/${secretName(olderPair)}`));
        expect(aborted).toBeGreaterThanOrEqual(0);
        expect(deletes.slice(aborted + 1)).toEqual([]);
    });

    // The Job controller marks a Job failed (FailureTarget) before its pod is over: a supervisor still
    // running is still finalizing, its report still to come — waited out, never read early.
    it('waits out a Job already marked failed while its supervisor still runs, then reads its report', async () => {
        let podReads = 0;
        let ended = false;
        const { request, calls } = earlier({
            item: priorItem({ failed: 1, conditions: [{ type: 'FailureTarget', reason: 'PodFailurePolicy' }] }),
            statuses: [jobAnswer({ failed: 1 })],
            pods: () => {
                podReads += 1;
                ended = podReads > 2;
                return ended
                    ? runnerPods({ terminated: { exitCode: 137 } }, { terminated: { exitCode: 0 } })
                    : runnerPods({ terminated: { exitCode: 137 } }, { running: {} });
            },
            supervisorLog: () =>
                ended
                    ? reportLog({ outcome: 'failed', cause: 'artifact_spool_full', agentEnd: 'killed' })
                    : { status: 200, body: 'serving steps\n' },
        });

        const adopted = await runner(request).adopt(adopter);

        expect((adopted as AdoptedRun | null)?.outcome.artifactSpoolFull).toBe(
            'the supervisor reported the spool full'
        );
        expect(podReads).toBeGreaterThan(2);
        const secretGone = calls.findIndex(
            (call) => call.method === 'DELETE' && call.path.endsWith(`/secrets/${secretName(job)}`)
        );
        expect(secretGone).toBeGreaterThan(-1);
    });

    // Failure injection: a listing the apiserver refused for a moment is read again, never taken for
    // "nothing to adopt" or a reason to run afresh — whose fence would sweep a finalizing group unread.
    it('lists the earlier runners again after a refusal, and adopts the one it finds', async () => {
        let refusals = 1;
        const { request: base } = earlier({ item: priorItem({ succeeded: 1 }) });
        const request: K8sRequest = (method, path, body) =>
            method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`) && refusals-- > 0
                ? Promise.resolve({ status: 503, body: 'unavailable' })
                : base(method, path, body);

        expect(await runner(request).adopt(adopter)).toMatchObject({ claimSeq: 1 });
    });

    it('stands down, claiming nothing, when the earlier runners cannot be listed', async () => {
        const { request: base, calls } = earlier();
        const request: K8sRequest = (method, path, body) =>
            method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)
                ? Promise.resolve({ status: 503, body: 'unavailable' })
                : base(method, path, body);

        await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(claimedAt(calls)).toBe(-1);
    });

    // A pod the kubelet rejected before any container started has no supervisor log to read (400):
    // no report, and a group nothing finalized — the run redone in its session, never a takeover
    // that stands down again and again.
    it('takes a runner pod rejected before its supervisor started as taken away, not unreadable', async () => {
        const rejected = {
            status: 200,
            body: JSON.stringify({
                items: [
                    {
                        metadata: { name: podName },
                        status: { phase: 'Failed', reason: 'UnexpectedAdmissionError', message: 'device unavailable' },
                    },
                ],
            }),
        };
        const { request, calls } = earlier({
            item: priorItem({ failed: 1 }),
            pods: rejected,
            supervisorLog: { status: 400, body: 'container "supervisor" in pod is not available' },
        });

        expect(await runner(request).adopt(adopter)).toBeNull();

        expect(deletedPrior(calls)).toBe(false);
        expect((await request('GET', claimPathFor(job.id))).status).toBe(404);
    });

    // The lost driver can still record why it ended the run while this claim waits: the record on
    // the Job as it ends is the one read, as docker reads its markers after the wait.
    it('reads the kill record the Job carries once it ends, not the one it was listed with', async () => {
        const { request } = earlier({
            statuses: [
                STILL_FINALIZING,
                {
                    status: 200,
                    body: JSON.stringify({
                        metadata: {
                            uid: `uid-${priorName}`,
                            annotations: { 'factory.kill.artifact_spool_full': '2000000000 bytes' },
                        },
                        status: { succeeded: 1 },
                    }),
                },
            ],
        });

        const adopted = await runner(request).adopt(adopter);

        expect((adopted as AdoptedRun | null)?.outcome.artifactSpoolFull).toBe('2000000000 bytes');
    });

    // Failure injection: a pod list that answers 200 with no list in it proves no pod over.
    it('stands down, deleting nothing, when the pod list of a finished Job answers malformed', async () => {
        let podReads = 0;
        const { request, calls } = earlier({
            statuses: [jobAnswer({ succeeded: 1 })],
            pods: () => (++podReads === 1 ? FINALIZING : { status: 200, body: '{"kind":"Status"}' }),
        });

        await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(deletedPrior(calls)).toBe(false);
    });

    it('stands down, deleting nothing, when the pod list of a finished Job answers null', async () => {
        let podReads = 0;
        const { request, calls } = earlier({
            statuses: [jobAnswer({ succeeded: 1 })],
            pods: () => (++podReads === 1 ? FINALIZING : { status: 200, body: 'null' }),
        });

        await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(deletedPrior(calls)).toBe(false);
    });

    // Once an earlier run is found, nothing unexpected may fall through to a fresh run, whose
    // sync's fence would sweep that run unread: any throw stands the attempt down.
    it('stands down, deleting nothing, on any unexpected throw once an earlier run is found', async () => {
        const { request: base, calls } = earlier({ item: priorItem({ succeeded: 1 }) });
        const request: K8sRequest = (method, path, body) =>
            method === 'POST' && path === configmapsPath
                ? Promise.reject(new TypeError('something unforeseen'))
                : base(method, path, body);

        const adopting = runner(request).adopt(adopter);

        await expect(adopting).rejects.toBeInstanceOf(AdoptionBlocked);
        await expect(adopting).rejects.toThrow('something unforeseen');
        expect(deletedPrior(calls)).toBe(false);
    });

    // A supervisor the kubelet could not start reads terminated (`StartError`), never having run.
    it('takes a supervisor that failed to start as never having run, not as an unreadable log', async () => {
        const { request, calls } = earlier({
            item: priorItem({ failed: 1 }),
            pods: {
                status: 200,
                body: JSON.stringify({
                    items: [
                        {
                            metadata: { name: podName },
                            status: {
                                phase: 'Failed',
                                containerStatuses: [
                                    { name: AGENT_CONTAINER, state: { waiting: { reason: 'PodInitializing' } } },
                                    {
                                        name: SUPERVISOR_CONTAINER,
                                        state: {
                                            terminated: { exitCode: 128, reason: 'StartError', message: 'exec failed' },
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                }),
            },
            supervisorLog: { status: 400, body: 'container "supervisor" in pod is not available' },
        });

        expect(await runner(request).adopt(adopter)).toBeNull();

        expect(deletedPrior(calls)).toBe(false);
        expect((await request('GET', claimPathFor(job.id))).status).toBe(404);
    });

    it('stands down, claiming nothing, when the earlier runner list answers malformed', async () => {
        const { request: base, calls } = earlier();
        const request: K8sRequest = (method, path, body) =>
            method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)
                ? Promise.resolve({ status: 200, body: '{"kind":"Status"}' })
                : base(method, path, body);

        await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(claimedAt(calls)).toBe(-1);
    });

    /*
     * Class (a), #824: a read that is not confirmed is never taken for "none", "running" or "gone".
     * Each row answers one read of the adoption with something that proves nothing; the adoption
     * stands down, and nothing of the earlier run is deleted.
     */
    const ENDED_FAILED = runnerPods({ terminated: { exitCode: 0 } }, { terminated: { exitCode: 0 } });
    const nthPodList = (n: number, answer: K8sResponse) => {
        let reads = 0;
        return () => (++reads === n ? answer : ENDED_FAILED);
    };
    it.each<[string, Parameters<typeof earlier>[0], ((base: K8sRequest) => K8sRequest)?]>([
        ['a finalizing Job read answering {}', { statuses: [{ status: 200, body: '{}' }] }],
        [
            'a pod not over that says nothing of its supervisor',
            {
                item: priorItem({ succeeded: 1 }),
                statuses: [jobAnswer({ succeeded: 1 })],
                pods: {
                    status: 200,
                    body: JSON.stringify({
                        items: [
                            {
                                metadata: { name: podName },
                                status: {
                                    phase: 'Running',
                                    containerStatuses: [
                                        { name: AGENT_CONTAINER, state: { terminated: { exitCode: 0 } } },
                                    ],
                                },
                            },
                        ],
                    }),
                },
            },
        ],
        [
            'a runner Job list with a null entry',
            {},
            (base) => (method, path, body) =>
                method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)
                    ? Promise.resolve({ status: 200, body: '{"items":[null]}' })
                    : base(method, path, body),
        ],
        [
            'the verdict pod list answering {}',
            { item: priorItem({ failed: 1 }), pods: nthPodList(3, { status: 200, body: '{}' }) },
        ],
        [
            'an agent log that never answers',
            { item: priorItem({ succeeded: 1 }) },
            (base) => (method, path, body) =>
                method === 'GET' && isAgentLogRead(path)
                    ? Promise.resolve({ status: 503, body: 'unavailable' })
                    : base(method, path, body),
        ],
        [
            "the sweep's pod list answering {}",
            { item: priorItem({ succeeded: 1 }) },
            (base) => (method, path, body) =>
                method === 'GET' &&
                path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) &&
                decodeURIComponent(path).includes('factory.lease!=')
                    ? Promise.resolve({ status: 200, body: '{}' })
                    : base(method, path, body),
        ],
    ])('stands down, deleting nothing, on %s', async (_what, setup, wrap) => {
        const { request: base, calls } = earlier(setup);
        const request = wrap ? wrap(base) : base;

        await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(deletedPrior(calls)).toBe(false);
    });

    // BEL-160: the sweep after the read run meets a pod stuck terminating on a gone node.
    it('hands an adoption whose sweep meets an older pod stuck terminating back as a blocked interruption, the read run kept', async () => {
        const { request: base, calls } = earlier({ item: priorItem({ succeeded: 1 }) });
        const stuck = {
            metadata: {
                name: 'stuck-pod',
                uid: 'uid-stuck-pod',
                labels: { 'factory.job': job.id, 'factory.lease': OTHER_LEASE, 'job-name': 'job-of-other-lease' },
                deletionTimestamp: '2026-10-29T10:00:00Z',
            },
            spec: { nodeName: 'node-a' },
        };
        const request: K8sRequest = (method, path, body) =>
            method === 'GET' &&
            path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) &&
            decodeURIComponent(path).includes('factory.lease!=')
                ? Promise.resolve({ status: 200, body: JSON.stringify({ items: [stuck] }) })
                : base(method, path, body);
        const stub = stubBoard([adopter]);
        const lines: string[] = [];

        await drive({ ...stub, runner: runner(request), log: (line) => lines.push(line) });

        expect(stub.board.interrupted).toHaveLength(1);
        expect(stub.board.interrupted[0]).toMatchObject({
            id: adopter.id,
            release: true,
            blocked: true,
            refused: true,
        });
        expect(stub.board.interrupted[0]!.reason).toContain('stuck-pod');
        expect(stub.board.interrupted[0]!.reason).toContain('node-a');
        expect(stub.board.completed).toEqual([]);
        expect(deletedPrior(calls)).toBe(false);
        expect(lines.some((line) => line.includes('leaving it to the lease'))).toBe(false);
        expect(calls.some((call) => call.method === 'POST' && call.path === jobsPath(namespace))).toBe(false);
    });

    it('reads the agent log again after a refusal, and adopts the run with its output', async () => {
        let refusals = 1;
        const { request: base } = earlier({ item: priorItem({ succeeded: 1 }) });
        const request: K8sRequest = (method, path, body) =>
            method === 'GET' && isAgentLogRead(path) && refusals-- > 0
                ? Promise.resolve({ status: 503, body: 'unavailable' })
                : base(method, path, body);

        expect(((await runner(request).adopt(adopter)) as AdoptedRun | null)?.outcome.output).toContain('did the work');
    });

    // A Stop while the earlier runners are read: no claim is taken, so no stale claim is deleted.
    it('takes no claim once the attempt stands down during discovery', async () => {
        const standDown = new AbortController();
        const { request: base, calls } = earlier({ item: priorItem({ succeeded: 1 }) });
        const request: K8sRequest = (method, path, body) => {
            if (method === 'GET' && isRunnerPodList(path)) standDown.abort();
            return base(method, path, body);
        };

        await expect(runner(request).adopt(adopter, standDown.signal)).rejects.toThrow(/abandoned/);

        expect(calls.some((call) => call.path.startsWith(configmapsPath) && call.method !== 'GET')).toBe(false);
    });

    // A node drained mid-finalization: the pod is terminating, its agent exited, its supervisor still
    // running — the group a claim must wait out, never sweep (#824).
    it('waits out a supervisor finalizing on a terminating pod, then adopts its run', async () => {
        let ended = false;
        const terminating = { deletionTimestamp: '2026-01-01T00:00:00Z' };
        const { request, calls } = earlier({
            statuses: [STILL_FINALIZING, jobAnswer({ succeeded: 1 })],
            pods: () =>
                ended
                    ? runnerPods({ terminated: { exitCode: 0 } }, { terminated: { exitCode: 0 } }, terminating)
                    : runnerPods({ terminated: { exitCode: 0 } }, { running: {} }, terminating),
            onPoll: (poll) => {
                ended = poll >= 2;
            },
            supervisorLog: reportLog({}),
        });

        const adopted = await runner(request).adopt(adopter);

        expect(adopted).toMatchObject({ claimSeq: 1, outcome: { exitCode: 0, started: true, sessionId: SESSION } });
        expect((adopted as AdoptedRun | null)?.outcome.output).toContain('did the work');
        expect((adopted as AdoptedRun | null)?.outcome).not.toHaveProperty('infraLoss');
        expect(calls.some((call) => isSupervisorLogRead(call.path))).toBe(true);
        expect(claimedAt(calls)).toBeGreaterThanOrEqual(0);
    });

    // The drain deleted the pod after its supervisor finalized: it is still listed, being deleted,
    // its report readable — the run it finished, read as such, never taken for a pod gone.
    it('adopts the run of a pod being deleted after its supervisor reported, with the report’s verdict', async () => {
        const { request, calls } = earlier({
            item: priorItem({ failed: 1 }),
            statuses: [jobAnswer({ failed: 1 })],
            pods: runnerPods(
                { terminated: { exitCode: 137 } },
                { terminated: { exitCode: 0 } },
                { deletionTimestamp: '2026-01-01T00:00:00Z' }
            ),
            supervisorLog: reportLog({
                outcome: 'failed',
                cause: 'artifact_spool_full',
                agentExit: 137,
                agentEnd: 'killed',
            }),
        });

        const adopted = await runner(request).adopt(adopter);

        expect(adopted).toMatchObject({ claimSeq: 1, outcome: { exitCode: 137, started: true, sessionId: SESSION } });
        expect((adopted as AdoptedRun | null)?.outcome.artifactSpoolFull).toBe(
            'the supervisor reported the spool full'
        );
        expect((adopted as AdoptedRun | null)?.outcome.output).toContain('did the work');
        expect((adopted as AdoptedRun | null)?.outcome).not.toHaveProperty('infraLoss');
        // The read run's Job is kept for a later claim (#821); only its Secrets go.
        expect(
            calls.some((call) => call.method === 'DELETE' && call.path.startsWith(jobPath(namespace, priorName)))
        ).toBe(false);
    });

    it.each([
        ['a 400 that is no never-started refusal stands down', 'Bad Request: invalid tailLines', true],
        ['a never-started agent is no log', 'container "agent" in pod "p" is waiting to start: PodInitializing', false],
    ])('reads an agent log answered 400: %s', async (_what, body, blocked) => {
        const { request: base, calls } = earlier({ item: priorItem({ succeeded: 1 }) });
        const request: K8sRequest = (method, path, b) =>
            method === 'GET' && isAgentLogRead(path)
                ? Promise.resolve({ status: 400, body: JSON.stringify({ kind: 'Status', message: body }) })
                : base(method, path, b);

        const adopting = runner(request).adopt(adopter);

        if (blocked) {
            await expect(adopting).rejects.toBeInstanceOf(AdoptionBlocked);
            expect(deletedPrior(calls)).toBe(false);
        } else {
            expect(((await adopting) as AdoptedRun | null)?.outcome.output).toBe('');
        }
    });

    // Discovery is contained too: a malformed field anywhere in what it reads stands the attempt down.
    it('stands down, claiming nothing, when discovery meets a malformed pod', async () => {
        const { request, calls } = earlier({
            pods: {
                status: 200,
                body: JSON.stringify({ items: [{ metadata: { name: podName }, status: { containerStatuses: 'x' } }] }),
            },
        });

        await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(claimedAt(calls)).toBe(-1);
    });

    it('answers null when this job has no earlier runner', async () => {
        const { request } = withRunners([]);
        expect(await runner(request).adopt(adopter)).toBeNull();
    });

    it('marks every runner Job with its claim sequence and session, for the next claim to read', () => {
        expect(spec().metadata.annotations).toEqual({
            'factory.claim-seq': '1',
            'factory.session': SESSION,
            'factory.command': commandMark(job.command),
        });
    });
});
