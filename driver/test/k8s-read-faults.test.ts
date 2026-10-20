/**
 * Every read of the kubernetes runner's destructive and verdict paths, replayed faulted (issue #869):
 * the fence and its sweep, a contended claim, the group's end, the reaper's two verdicts, an
 * adoption of a finished and of a finalizing runner, a run's verdict and the dead-service probe. The
 * engine and its rules are `fixtures/read-faults.ts`; each scenario's world is "something there",
 * so every read that guards a delete or a verdict answers non-empty when clean.
 *
 * The destructive paths read typed (#869 PR A): a cell that holds is a plain test. What stays pinned
 * `it.fails` with its exact line set, read from an unpinned run, is the verdict paths (K-V1, K-D1),
 * which typed reads (#869 PR B) flip. The stopAgent and kill of a kubernetes runner
 * (`k8s-runner.ts`) are not replayed here — their docker twins are.
 */
import { randomUUID } from 'node:crypto';
import { describe } from 'vitest';
import type { Board, BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { commandMark } from '../src/runner.js';
import type { K8sRequest, K8sResponse } from '../src/k8s-transport.js';
import { jobsPath, runnerJobName } from '../src/k8s-podspec.js';
import { jobPath } from '../src/k8s-auxspec.js';
import { createKubernetesReaper } from '../src/k8s-reaper.js';
import { createKubernetesRunner } from '../src/k8s-runner.js';
import { createReaper } from '../src/reaper.js';
import { AGENT_CONTAINER, SUPERVISOR_CONTAINER, serviceContainerOf } from '../src/supervisor-contract.js';
import { k8sApiserver, type Special } from './fixtures/k8s-apiserver.js';
import {
    type Alias,
    type AllowedWrite,
    type Build,
    cleanK8s,
    faultCell,
    freshJob,
    guardScenario,
    K8S_FAULTS,
    type K8sFault,
    pin,
    quietSteps,
    replayK8s,
} from './fixtures/read-faults.js';

const NS = 'factory';
const START = '2026-08-20T06:00:00.000Z';

const runnerOf = (request: K8sRequest, leases?: Board['leases']) =>
    createKubernetesRunner(
        loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: NS, RUNNER_SERVICES: '1' }),
        request,
        async () => {},
        { steps: quietSteps(), ...(leases ? { leases } : {}) }
    );

const list = (items: unknown[]): K8sResponse => ({ status: 200, body: JSON.stringify({ items }) });
const isGet = (method: string, path: string, prefix: string): boolean => method === 'GET' && path.startsWith(prefix);
const selector = (path: string): string => decodeURIComponent(path);
const PODS = `/api/v1/namespaces/${NS}/pods`;
const CONFIGMAPS = `/api/v1/namespaces/${NS}/configmaps`;

/** Names `pair`'s job, its lease and every name hashed from the two by `label`'s role. */
const aliasPair = (alias: Alias, pair: BoardJob, label: string): void => {
    alias(pair.id, 'job');
    alias(pair.leaseToken, label);
    alias(runnerJobName(pair).slice('factory-runner-'.length), `${label}-hash`);
};

/** One fake API server for `job`, `special` in front of it. */
const serverFor = (job: BoardJob, special: Special) =>
    k8sApiserver({ namespace: NS, podName: `${runnerJobName(job)}-xxxxx` }).routed(special);

/** A pod of `job`, in `phase`, its containers in the states given. */
const podOf = (name: string, phase: string, labels: Record<string, string>, containers: unknown[] = []) => ({
    metadata: { name, uid: `uid-${name}`, labels, creationTimestamp: START },
    spec: { containers: [{ name: 'main', image: 'postgres:17' }] },
    status: { phase, containerStatuses: containers },
});

/** An earlier claim's runner Job of `job`, as the label listing answers it. */
const earlierRunner = (job: BoardJob, lease: string, status: Record<string, unknown>) => ({
    metadata: {
        name: runnerJobName({ ...job, leaseToken: lease }),
        uid: randomUUID(),
        labels: { 'factory.job': job.id, 'factory.lease': lease },
        creationTimestamp: START,
        annotations: {
            'factory.claim-seq': '1',
            'factory.session': randomUUID(),
            'factory.command': commandMark(job.command),
        },
    },
    spec: { template: { spec: { containers: [{ name: SUPERVISOR_CONTAINER }, { name: AGENT_CONTAINER }] } } },
    status: { startTime: START, ...status },
});

/** K-FS: the sync's fence sweeps an earlier lease's runner Job and pod, listed until each is deleted. */
const fenceSweep: Build<K8sRequest> = async (tap, alias) => {
    const job = freshJob();
    const old = randomUUID();
    aliasPair(alias, job, 'lease');
    aliasPair(alias, { ...job, leaseToken: old }, 'old');
    const labels = { 'factory.job': job.id, 'factory.lease': old };
    let jobs = [{ metadata: { name: runnerJobName({ ...job, leaseToken: old }), uid: randomUUID(), labels } }];
    let pods = [podOf(`${jobs[0]!.metadata.name}-old`, 'Running', labels)];
    const { request } = serverFor(job, (method, path) => {
        if (isGet(method, path, `${jobsPath(NS)}?`)) return list(jobs);
        if (isGet(method, path, `${PODS}?`) && selector(path).includes('factory.lease!=')) return list(pods);
        if (method === 'DELETE' && path.startsWith(`${jobsPath(NS)}/`)) {
            jobs = jobs.filter((item) => !path.startsWith(jobPath(NS, item.metadata.name)));
            return { status: 200, body: '{}' };
        }
        if (method === 'DELETE' && path.startsWith(`${PODS}/`)) {
            pods = pods.filter((item) => !path.startsWith(`${PODS}/${item.metadata.name}?`));
            return { status: 200, body: '{}' };
        }
    });
    const runner = runnerOf(tap(request));
    return async () => {
        await runner.syncCheckout(job, undefined, { id: randomUUID(), resume: false });
        return [];
    };
};

/** K-FH: the sync's claim is held, with no claim sequence, by another lease the board says is live. */
const fenceHeld: Build<K8sRequest> = async (tap, alias) => {
    const job = freshJob();
    const other = randomUUID();
    aliasPair(alias, job, 'lease');
    aliasPair(alias, { ...job, leaseToken: other }, 'holder');
    const { request } = serverFor(job, () => undefined);
    const posted = await request('POST', CONFIGMAPS, {
        metadata: { name: `factory-job-${job.id}-claim` },
        data: { holder: other, claimSeq: '' },
    });
    if (posted.status !== 201) throw new Error(`the held claim was not created: ${posted.status}`);
    const runner = runnerOf(tap(request), async (ids) =>
        ids.includes(job.id) ? [{ id: job.id, status: 'running', leaseToken: other }] : []
    );
    return async () => {
        await runner.syncCheckout(job, undefined, { id: randomUUID(), resume: false });
        return [];
    };
};

/** K-T1: the group's end, a writer pod of it still running: the claim is held, never given back. */
const teardownHeld: Build<K8sRequest> = async (tap, alias) => {
    const job = freshJob();
    aliasPair(alias, job, 'lease');
    const writer = podOf(`${runnerJobName(job)}-xxxxx`, 'Running', {});
    const { request } = serverFor(job, (method, path) =>
        isGet(method, path, `${PODS}?`) && selector(path).endsWith(`factory.lease=${job.leaseToken}`)
            ? list([writer])
            : undefined
    );
    const runner = runnerOf(tap(request));
    await runner.syncCheckout(job, undefined, { id: randomUUID(), resume: false });
    return async () => {
        await runner.finish(job);
        return [];
    };
};

/** A reaper round over `request`, the board answering `leases` for every id. */
const reaperOver = (request: K8sRequest, leases: Parameters<typeof createReaper>[0]['board']['leases']) =>
    createReaper({
        board: { leases },
        arm: createKubernetesReaper({
            config: loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: NS }),
            request,
            sleep: async () => {},
        }),
        intervalMs: 0,
        graceMs: 0,
        log: () => {},
    });

/** K-R1: a live job's superseded lease left an unread finished runner (its sidecars end with it, issue #773). */
const reaperSuperseded: Build<K8sRequest> = async (tap, alias) => {
    const job = freshJob();
    const old = randomUUID();
    aliasPair(alias, { ...job, leaseToken: old }, 'old');
    const runnerJob = earlierRunner(job, old, { succeeded: 1 });
    const { request } = serverFor(job, (method, path) =>
        isGet(method, path, `${jobsPath(NS)}?`) ? list([runnerJob]) : undefined
    );
    const reaper = reaperOver(tap(request), async () => [{ id: job.id, status: 'running', leaseToken: randomUUID() }]);
    return async () => {
        await reaper.sweep();
        return [];
    };
};

/** K-R2: a job gone from the board, its claim observed, a reclaim pod of the claim's holder still running. */
const reaperGone: Build<K8sRequest> = async (tap, alias) => {
    const job = freshJob();
    aliasPair(alias, job, 'lease');
    const reclaim = podOf('reclaim-pod', 'Running', {});
    const runnerJob = earlierRunner(job, job.leaseToken, { succeeded: 1 });
    const server = serverFor(job, (method, path) => {
        if (isGet(method, path, `${PODS}?`) && selector(path).includes(`factory.holder=${job.leaseToken}`)) {
            return list([reclaim]);
        }
        if (isGet(method, path, `${jobsPath(NS)}?`)) return list([runnerJob]);
    });
    const posted = await server.request('POST', CONFIGMAPS, {
        metadata: { name: `factory-job-${job.id}-claim` },
        data: { holder: job.leaseToken, claimSeq: '1' },
    });
    if (posted.status !== 201) throw new Error(`the claim was not created: ${posted.status}`);
    const reaper = reaperOver(tap(server.request), async () => []);
    return async () => {
        await reaper.sweep();
        return [];
    };
};

/** K-A1: an earlier claim's runner finished and its pod is over: adopted, its Job kept. */
const adoptFinished: Build<K8sRequest> = async (tap, alias) => {
    const prior = freshJob({ claimSeq: 1 });
    const adopter = { ...prior, leaseToken: randomUUID(), claimSeq: 2 };
    aliasPair(alias, prior, 'prior');
    aliasPair(alias, adopter, 'lease');
    const item = earlierRunner(prior, prior.leaseToken, { succeeded: 1 });
    const { request } = serverFor(prior, (method, path) =>
        isGet(method, path, `${jobsPath(NS)}?`) ? list([item]) : undefined
    );
    const runner = runnerOf(tap(request));
    return async () => ((await runner.adopt(adopter)) === null ? ['no-earlier-run'] : []);
};

/** K-A2: an earlier claim's agent exited while its supervisor finalizes; the Job ends on its third read. */
const adoptFinalizing: Build<K8sRequest> = async (tap, alias) => {
    const prior = freshJob({ claimSeq: 1 });
    const adopter = { ...prior, leaseToken: randomUUID(), claimSeq: 2 };
    aliasPair(alias, prior, 'prior');
    aliasPair(alias, adopter, 'lease');
    const item = earlierRunner(prior, prior.leaseToken, { active: 1 });
    const priorPath = jobPath(NS, item.metadata.name);
    const pod = (supervisor: Record<string, unknown>) =>
        list([
            podOf(`${item.metadata.name}-xxxxx`, 'Running', {}, [
                { name: AGENT_CONTAINER, state: { terminated: { exitCode: 0 } } },
                { name: SUPERVISOR_CONTAINER, state: supervisor },
            ]),
        ]);
    let reads = 0;
    const { request } = serverFor(prior, (method, path) => {
        if (isGet(method, path, `${jobsPath(NS)}?`)) return list([item]);
        if (method === 'GET' && path.split('?')[0] === priorPath) {
            reads += 1;
            if (reads >= 3) item.status = { startTime: START, succeeded: 1 } as typeof item.status;
            return {
                status: 200,
                body: JSON.stringify({
                    metadata: { name: item.metadata.name, uid: item.metadata.uid },
                    status: item.status,
                }),
            };
        }
        if (isGet(method, path, `${PODS}?`) && selector(path).includes('job-name=')) {
            return 'succeeded' in item.status ? pod({ terminated: { exitCode: 0 } }) : pod({ running: {} });
        }
    });
    const runner = runnerOf(tap(request));
    return async () => ((await runner.adopt(adopter)) === null ? ['no-earlier-run'] : []);
};

/** The verdicts a run reports: an infrastructure loss, a run that never started. */
const runVerdicts = (outcome: { infraLoss?: string; started: boolean }): string[] => [
    ...(outcome.infraLoss ? [`infra-loss: ${outcome.infraLoss}`] : []),
    ...(outcome.started ? [] : ['never-started']),
];

/** K-V1: the run's Job failed, its pod live, its agent exited 1: a run's own failure, no loss. */
const runVerdict: Build<K8sRequest> = async (tap, alias) => {
    const job = freshJob();
    aliasPair(alias, job, 'lease');
    const pod = podOf(`${runnerJobName(job)}-xxxxx`, 'Running', {}, [
        { name: AGENT_CONTAINER, state: { terminated: { exitCode: 1 } } },
        { name: SUPERVISOR_CONTAINER, state: { running: {} } },
    ]);
    const failed = { status: { failed: 1, conditions: [{ type: 'Failed', reason: 'BackoffLimitExceeded' }] } };
    const { request } = serverFor(job, (method, path) => {
        if (isGet(method, path, `${PODS}?`) && selector(path).includes('job-name=')) return list([pod]);
        if (method === 'GET' && path.split('?')[0] === jobPath(NS, runnerJobName(job))) {
            return { status: 200, body: JSON.stringify(failed) };
        }
    });
    const runner = runnerOf(tap(request));
    const session = { id: randomUUID(), resume: false };
    await runner.syncCheckout(job, undefined, session);
    return async () => runVerdicts(await runner.run(job, session));
};

/** K-D1: the attempt's one declared service runs, a sidecar of its task pod (issue #773). */
const deadService: Build<K8sRequest> = async (tap, alias) => {
    const job = { ...freshJob(), services: [{ name: 'db', image: 'postgres:17', environment: [] }] };
    aliasPair(alias, job, 'lease');
    const base = podOf(`${runnerJobName(job)}-xxxxx`, 'Running', {});
    const pod = {
        ...base,
        status: {
            ...base.status,
            initContainerStatuses: [
                { name: serviceContainerOf('db'), image: 'postgres:17', state: { running: {} }, restartCount: 0 },
            ],
        },
    };
    const { request } = serverFor(job, (method, path) =>
        isGet(method, path, `${PODS}?`) && selector(path).includes('job-name=') ? list([pod]) : undefined
    );
    const runner = runnerOf(tap(request));
    await runner.syncCheckout(job, undefined, { id: randomUUID(), resume: false });
    return async () => (await runner.deadServices(job)).map((service) => `dead ${service.name}`);
};

const API = `/api/v1/namespaces/${NS}`;
const BATCH = `/apis/batch/v1/namespaces/${NS}`;
const CLAIM = `${API}/configmaps/factory-job-<job>-claim`;
const OLD_JOBS = `GET ${BATCH}/jobs?labelSelector=factory.job=<job>,factory.lease!=<lease>`;
const OLD_PODS = `GET ${API}/pods?labelSelector=factory.job=<job>,factory.lease!=<lease>`;
const secretsOf = (label: string): string[] => [`DELETE ${API}/secrets/factory-job-<job>-<${label}>-env`];
const ADOPTED_WRITES = [
    `POST ${API}/configmaps`,
    `POST ${BATCH}/jobs`,
    `DELETE ${BATCH}/jobs/factory-cturns-<prior-hash>`,
    ...secretsOf('prior'),
];
const NULL_READ = (field: string) => `Cannot read properties of null (reading '${field}')`;

/** A scenario's pins, by fault: one line per documented violation. */
type Pins = Partial<Record<K8sFault, RegExp[]>>;
/** The faults a body that parses to no list (`{}`, a `Status`, cut JSON) or to `null` stands for. */
const GARBAGE: readonly K8sFault[] = ['empty-object', 'status', 'truncated'];
const pinsFor = (faults: readonly K8sFault[], lines: (fault: K8sFault) => string[]): Pins =>
    Object.fromEntries(faults.map((fault) => [fault, lines(fault).map(pin)]));

/** What a scenario's clean run writes, and the writes a faulted run may add because the code authorizes them on its own. */
interface Expected {
    writes: string[];
    allowed?: AllowedWrite[];
}

function scenario(name: string, build: Build<K8sRequest>, { writes, allowed }: Expected, pins: Pins): void {
    describe(name, () => {
        guardScenario(() => cleanK8s(build), { writes });
        for (const fault of K8S_FAULTS) {
            faultCell(fault, () => replayK8s(build, fault, allowed ? { allowed } : {}), pins[fault] ?? []);
        }
    });
}

const CLAIM_READ = `GET ${CLAIM}`;

scenario(
    'the sync fence sweeping an earlier lease (K-FS)',
    fenceSweep,
    {
        writes: [
            `POST ${API}/configmaps`,
            `POST ${API}/configmaps`,
            ...secretsOf('old'),
            `DELETE ${BATCH}/jobs/factory-runner-<old-hash>`,
            `DELETE ${API}/pods/factory-runner-<old-hash>-old`,
            `POST ${BATCH}/jobs`,
            `POST ${API}/secrets`,
            `PATCH ${BATCH}/jobs/factory-runner-<lease-hash>`,
        ],
        allowed: [
            ...[...secretsOf('lease'), `DELETE ${BATCH}/jobs/factory-runner-<lease-hash>`].map((write) => ({
                write,
                at: [CLAIM_READ],
                why:
                    'the sync stands down before its group exists and ends it by its own derived names only ' +
                    '(`k8s-runner.ts:440-444` → `k8s-group.ts:244-247` → `k8s-teardown.ts:175-190`)',
            })),
            ...secretsOf('old').map((write) => ({
                write,
                at: [OLD_JOBS, OLD_PODS],
                why:
                    'the next sweep pass re-lists the leftover and re-derives its Secrets from the listed lease, ' +
                    'a 404 acknowledged (`k8s-fence.ts:429-447`, `k8s-teardown.ts:36-56`)',
            })),
        ],
    },
    {}
);

scenario('the sync fence on a claim a live lease holds (K-FH)', fenceHeld, { writes: [`POST ${API}/configmaps`] }, {});

scenario('the group end while a writer pod still runs (K-T1)', teardownHeld, { writes: secretsOf('lease') }, {});

scenario(
    'the reaper on a superseded lease with an unread runner (K-R1)',
    reaperSuperseded,
    { writes: [] },
    // The Job list is the arm's only read (a service is a sidecar of its Job, issue #773): a list
    // read as no runner Job names no group, so the superseded one is simply not reaped.
    {}
);

scenario(
    'the reaper on a gone job whose claim holder still runs a reclaim pod (K-R2)',
    reaperGone,
    { writes: [...secretsOf('lease'), `DELETE ${BATCH}/jobs/factory-runner-<lease-hash>`] },
    {}
);

/** An adoption's runner pod read after its claim is taken. */
const ADOPT_PODS = `GET ${API}/pods?labelSelector=job-name=factory-runner-<prior-hash>`;
/**
 * The claim an adoption took, given back when it stands down: no group of the adopter exists, and
 * the release reads the claim fresh and deletes it under its uid (`k8s-adopt.ts:384` →
 * `k8s-fence.ts:230-251`).
 */
const ADOPTER_CLAIM: AllowedWrite = {
    write: `DELETE ${CLAIM}`,
    at: [ADOPT_PODS, CLAIM_READ],
    why: 'the stand-down returns the claim the adoption acquired, uid-checked and fresh-read (`k8s-adopt.ts:384` → `k8s-fence.ts:230-251`)',
};

scenario(
    'an adoption of a finished earlier runner (K-A1)',
    adoptFinished,
    {
        writes: ADOPTED_WRITES,
        allowed: [ADOPTER_CLAIM],
    },
    {}
);

scenario(
    'an adoption of a runner whose supervisor finalizes (K-A2)',
    adoptFinalizing,
    {
        writes: ADOPTED_WRITES,
        allowed: [ADOPTER_CLAIM],
    },
    {}
);

/** The run's own runner pod list and Job status read. */
const RUN_PODS = `GET ${API}/pods?labelSelector=job-name=factory-runner-<lease-hash>`;
const LOST = 'infra-loss: the runner pod was deleted before it exited (evicted, drained or its node removed)';

scenario(
    'a run whose agent failed under a live pod (K-V1)',
    runVerdict,
    { writes: [`POST ${BATCH}/jobs`, `DELETE ${BATCH}/jobs/factory-cturns-<lease-hash>`] },
    {
        // No list read as no pod (`k8s-poll.ts:371`): the run reads as taken away (`k8s-poll.ts:635`,
        // `k8s-runner.ts:382`).
        ...pinsFor(GARBAGE, (fault) => [`VERDICT after ${fault} at ${RUN_PODS}: ${LOST}`]),
        null: [
            `CRASH after null at ${RUN_PODS}: ${NULL_READ('items')}`,
            // `readJobStatus` (`k8s-poll.ts:262`).
            `CRASH after null at GET ${BATCH}/jobs/factory-runner-<lease-hash>: ${NULL_READ('status')}`,
        ].map(pin),
    }
);

/** The dead-service probe's read of the task pod, whose sidecars the declared services are. */
const SERVICE_PODS = `GET ${API}/pods?labelSelector=job-name=factory-runner-<lease-hash>`;

scenario(
    'the dead-service probe of a running service (K-D1)',
    deadService,
    { writes: [] },
    {
        // A pod list that names no task pod is `Inconclusive` (`k8s-services.ts` `taskPod`): dead is
        // never inferred from it. Only a body of `null` crashes the list read itself.
        null: [pin(`CRASH after null at ${SERVICE_PODS}: ${NULL_READ('items')}`)],
    }
);
