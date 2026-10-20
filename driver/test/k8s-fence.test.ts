/**
 * The re-claim fence (`k8s-fence.ts`) called directly, its own functions rather than through a
 * runner: the claim, its release, the sweep, and the pre/post-create verifies. What
 * a runner-level scenario in `k8s.test.ts` already pins (a stale claim taken over by uid, the Secret
 * before the Job, the uid on every delete, the resume by uid) is not repeated here. Assertions are on
 * requests and on what is thrown or answered, never on how many times a read was retried.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BoardJob, BoardLease } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { claimBody, claimPath, configmapsPath, jobPath } from '../src/k8s-auxspec.js';
import {
    acquireClaim,
    launch,
    prepare,
    readClaim,
    releaseClaimAfterGroupEnd,
    sweepClaimedFleets,
} from '../src/k8s-fence.js';
import { jobsPath, runnerJobName, runnerName, type RunnerJobSpec, secretName } from '../src/k8s-podspec.js';
import {
    CLAIM_ROUNDS,
    REPLACE_WAIT_MS,
    type K8sDeps,
    type K8sRequestOptions,
    type K8sResponse,
} from '../src/k8s-transport.js';
import { AGENT_CONTAINER, SUPERVISOR_CONTAINER } from '../src/supervisor-contract.js';
import { k8sApiserver, type Special } from './fixtures/k8s-apiserver.js';

const NS = 'factory';
const OLD = '55555555-5555-4555-8555-555555555555';
const job: BoardJob = {
    id: '11111111-1111-4111-8111-111111111111',
    command: 'fix the failing build',
    attempts: 2,
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
const earlier: BoardJob = { ...job, leaseToken: OLD, claimSeq: 1, attempts: 1 };
const CLAIM = claimPath(NS, job);
const CONFIGMAPS = configmapsPath(NS);
const PODS = `/api/v1/namespaces/${NS}/pods`;

const server = k8sApiserver({ namespace: NS, podName: `${runnerJobName(job)}-xxxxx` });

/** The fence's world: `special` in front of the fake apiserver, every call recorded, sleeping instant. */
function world(special: Special = () => undefined, extra: Partial<K8sDeps> = {}) {
    const { request, calls } = server.routed(special);
    const deps: K8sDeps = {
        request,
        sleep: async () => {},
        config: loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: NS }),
        ...extra,
    };
    return { deps, calls };
}

const answer = (status: number, body: unknown = {}): K8sResponse => ({ status, body: JSON.stringify(body) });
const claimBodyOf = (claim: { uid?: string; holder?: string; seq?: string; annotations?: Record<string, string> }) => ({
    metadata: { ...(claim.uid ? { uid: claim.uid } : {}), annotations: claim.annotations ?? {} },
    data: { ...(claim.holder ? { holder: claim.holder } : {}), ...(claim.seq ? { claimSeq: claim.seq } : {}) },
});
const isClaimGet = (method: string, path: string) => method === 'GET' && path === CLAIM;
const deletes = (calls: { method: string; path: string; body?: unknown }[], prefix = '') =>
    calls.filter((call) => call.method === 'DELETE' && call.path.startsWith(prefix));
const posts = (calls: { method: string; path: string }[], path: string) =>
    calls.filter((call) => call.method === 'POST' && call.path === path);

describe('acquireClaim', () => {
    it('is one POST when the apiserver grants the name', async () => {
        const { deps, calls } = world();

        await acquireClaim(deps, job);

        expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([`POST ${CONFIGMAPS}`]);
        expect(calls[0]!.body).toMatchObject({ data: { holder: job.leaseToken, claimSeq: String(job.claimSeq) } });
    });

    it('gives up after CLAIM_ROUNDS takeovers, each preconditioned on the uid it read', async () => {
        const { deps, calls } = world((method, path) => {
            if (method === 'POST' && path === CONFIGMAPS) return answer(409);
            if (isClaimGet(method, path)) return answer(200, claimBodyOf({ uid: 'uid-1', holder: OLD, seq: '1' }));
            if (method === 'DELETE' && path === CLAIM) return answer(200);
        });

        await expect(acquireClaim(deps, job)).rejects.toThrow(
            `the checkout claim of job ${job.id} was never acquired after ${CLAIM_ROUNDS} rounds`
        );

        expect(posts(calls, CONFIGMAPS)).toHaveLength(CLAIM_ROUNDS);
        const released = deletes(calls, CLAIM);
        expect(released).toHaveLength(CLAIM_ROUNDS);
        expect(
            released.every((call) => (call.body as { preconditions: { uid: string } }).preconditions.uid === 'uid-1')
        ).toBe(true);
    });

    const lease =
        (leaseToken: string, status: BoardLease['status'] = 'running'): NonNullable<K8sDeps['leases']> =>
        async () => [{ id: job.id, status, leaseToken }];
    it.each<[string, K8sResponse, Partial<K8sDeps>, RegExp]>([
        [
            'a claim of an equal sequence',
            answer(200, claimBodyOf({ uid: 'u', holder: OLD, seq: '2' })),
            {},
            /newer claim/,
        ],
        [
            'a claim of a newer sequence',
            answer(200, claimBodyOf({ uid: 'u', holder: OLD, seq: '3' })),
            {},
            /newer claim/,
        ],
        ['a claim that cannot be read', answer(503), {}, /reading the checkout claim/],
        ['a claim that names no holder', answer(200, claimBodyOf({ uid: 'u', seq: '1' })), {}, /no holder/],
        ['an older claim that names no uid', answer(200, claimBodyOf({ holder: OLD, seq: '1' })), {}, /no uid/],
        [
            'a claim of no sequence with no lease lookup',
            answer(200, claimBodyOf({ uid: 'u', holder: OLD })),
            {},
            /no claim sequence/,
        ],
        [
            'a claim of no sequence while the board holds another lease live',
            answer(200, claimBodyOf({ uid: 'u', holder: OLD })),
            { leases: lease(OLD) },
            /no claim sequence/,
        ],
        [
            'a claim of no sequence while this lease is no longer running',
            answer(200, claimBodyOf({ uid: 'u', holder: OLD })),
            { leases: lease(job.leaseToken, 'queued') },
            /no claim sequence/,
        ],
        [
            'a claim of no sequence while the lease lookup fails',
            answer(200, claimBodyOf({ uid: 'u', holder: OLD })),
            {
                leases: async () => {
                    throw new Error('board down');
                },
            },
            /no claim sequence/,
        ],
    ])('stands down, deleting nothing, on %s', async (_label, read, extra, message) => {
        const { deps, calls } = world((method, path) => {
            if (method === 'POST' && path === CONFIGMAPS) return answer(409);
            if (isClaimGet(method, path)) return read;
        }, extra);

        await expect(acquireClaim(deps, job)).rejects.toThrow(message);

        expect(deletes(calls)).toEqual([]);
        expect(posts(calls, CONFIGMAPS)).toHaveLength(1);
    });
});

describe('readClaim', () => {
    it.each<[string, K8sResponse]>([
        ['absent', answer(404)],
        ['unreadable', answer(503)],
        ['without a uid', answer(200, claimBodyOf({ holder: OLD }))],
        ['without a holder', answer(200, claimBodyOf({ uid: 'u' }))],
        ['of a holder that is no lease', answer(200, claimBodyOf({ uid: 'u', holder: 'not-a-lease' }))],
    ])('answers null for a claim %s', async (_label, read) => {
        const { deps, calls } = world((method, path) => (isClaimGet(method, path) ? read : undefined));

        expect(await readClaim(deps, job)).toBeNull();
        // One GET: a read that is no answer is not retried into one.
        expect(calls).toHaveLength(1);
    });

    it('names the incarnation and its holder', async () => {
        const { deps } = world((method, path) =>
            isClaimGet(method, path) ? answer(200, claimBodyOf({ uid: 'u-1', holder: OLD })) : undefined
        );

        expect(await readClaim(deps, job)).toEqual({ uid: 'u-1', holder: OLD });
    });
});

describe('releaseClaimAfterGroupEnd', () => {
    /** A world whose claim is held by `holder` (through the fake's own claim server). */
    async function held(holder: BoardJob, special: Special = () => undefined, extra: Partial<K8sDeps> = {}) {
        const made = world(special, extra);
        const posted = await made.deps.request('POST', CONFIGMAPS, claimBody(holder));
        expect(posted.status).toBe(201);
        made.calls.length = 0;
        return made;
    }

    it('deletes the claim under the uid it has just read, and answers true', async () => {
        const { deps, calls } = await held(job);
        const uid = JSON.parse((await deps.request('GET', CLAIM)).body).metadata.uid;

        expect(await releaseClaimAfterGroupEnd(deps, job)).toBe(true);

        const [released] = deletes(calls, CLAIM);
        expect(released!.body).toMatchObject({ preconditions: { uid } });
        expect((await deps.request('GET', CLAIM)).status).toBe(404);
    });

    it('leaves a claim another holder took, deleting nothing', async () => {
        const { deps, calls } = await held(earlier);

        expect(await releaseClaimAfterGroupEnd(deps, job)).toBe(false);

        expect(deletes(calls)).toEqual([]);
    });

    it.each([
        ['a uid replaced since it was observed', { uid: 'claim-uid-other', holder: () => job.leaseToken }],
        ['a holder other than the one observed', { uid: undefined, holder: () => OLD }],
    ])('rejects an observation of %s before anything is ended', async (_label, seen) => {
        const { deps, calls } = await held(job);
        const now = JSON.parse((await deps.request('GET', CLAIM)).body).metadata.uid;
        calls.length = 0;

        const released = await releaseClaimAfterGroupEnd(deps, job, {
            observed: { uid: seen.uid ?? now, holder: seen.holder() },
        });

        expect(released).toBe(false);
        expect(calls.map((call) => call.method)).toEqual(['GET']);
    });

    it('keeps the claim while a group of its holder is live in this runner', async () => {
        const { deps, calls } = await held(job, () => undefined, {
            groups: new Map([[job.leaseToken, {} as never]]),
        });

        expect(await releaseClaimAfterGroupEnd(deps, job)).toBe(false);

        expect(deletes(calls)).toEqual([]);
    });

    it('answers false, never throwing, when the delete itself fails', async () => {
        const { deps, calls } = await held(job, (method, path) =>
            method === 'DELETE' && path === CLAIM ? Promise.reject(new Error('socket hang up')) : undefined
        );

        await expect(releaseClaimAfterGroupEnd(deps, job)).resolves.toBe(false);

        expect(deletes(calls, CLAIM)).toHaveLength(1);
    });
});

describe('sweepClaimedFleets', () => {
    const JOBS = `${jobsPath(NS)}?`;
    const leftoverOf = (lease: string, uid: string) => ({
        metadata: {
            name: runnerJobName({ ...job, leaseToken: lease }),
            uid,
            labels: { 'factory.job': job.id, 'factory.lease': lease },
        },
    });

    it('reads no claim when every kind answers empty', async () => {
        const { deps, calls } = world();

        await sweepClaimedFleets(deps, job, new AbortController().signal);

        expect(calls.every((call) => call.method === 'GET')).toBe(true);
        expect(calls.some((call) => call.path.startsWith(CONFIGMAPS))).toBe(false);
    });

    it('throws that it could not confirm the checkout empty, deleting nothing, when a kind never lists', async () => {
        const { deps, calls } = world((method, path) =>
            method === 'GET' && path.startsWith(JOBS) ? answer(503) : undefined
        );

        await expect(sweepClaimedFleets(deps, job, new AbortController().signal)).rejects.toThrow(
            /could not confirm the checkout empty/
        );

        expect(deletes(calls)).toEqual([]);
    });

    it('deletes an older lease’s Job and spares the run this attempt adopted, its pod and its Secret', async () => {
        const adoptedJob = {
            ...leftoverOf(earlier.leaseToken, 'uid-adopted'),
            spec: { template: { spec: { containers: [{ name: SUPERVISOR_CONTAINER }, { name: AGENT_CONTAINER }] } } },
            status: { succeeded: 1 },
        };
        const older = { ...leftoverOf(OLD.replace(/5/g, '6'), 'uid-older') };
        let listed = [adoptedJob, older];
        const adoptedPod = {
            metadata: {
                name: `${adoptedJob.metadata.name}-xxxxx`,
                uid: 'uid-pod',
                labels: { ...adoptedJob.metadata.labels, 'job-name': adoptedJob.metadata.name },
            },
        };
        const { deps, calls } = world((method, path) => {
            if (method === 'GET' && path.startsWith(JOBS)) return answer(200, { items: listed });
            if (method === 'GET' && path.startsWith(`${PODS}?`) && decodeURIComponent(path).includes('lease!=')) {
                return answer(200, { items: [adoptedPod] });
            }
            if (method === 'DELETE' && path.startsWith(jobPath(NS, older.metadata.name))) {
                listed = [adoptedJob];
                return answer(200);
            }
        });
        deps.adopted = new Map([[job.leaseToken, adoptedJob.metadata.name]]);
        await deps.request('POST', CONFIGMAPS, claimBody(job));
        calls.length = 0;

        await sweepClaimedFleets(deps, job, new AbortController().signal);

        const gone = deletes(calls).map((call) => call.path.split('?')[0]);
        expect(gone).toContain(jobPath(NS, older.metadata.name));
        expect(gone).toContain(
            `/api/v1/namespaces/${NS}/secrets/${secretName({ ...job, leaseToken: older.metadata.labels['factory.lease'] })}`
        );
        expect(gone.some((path) => path!.includes(adoptedJob.metadata.name))).toBe(false);
        expect(gone.some((path) => path!.endsWith(`/${secretName(earlier)}`))).toBe(false);
    });

    /** A clock that only the requests move: each call takes `ms` of wall-clock time. */
    function slowWorld(ms: number, special: Special) {
        let now = 5_000_000;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        const { deps, calls } = world(special);
        const inner = deps.request;
        const timeouts: { path: string; timeoutMs: number | undefined }[] = [];
        deps.request = async (method, path, body, options?: K8sRequestOptions) => {
            timeouts.push({ path, timeoutMs: options?.timeoutMs });
            now += ms;
            return inner(method, path, body, options);
        };
        return { deps, calls, timeouts, restore: () => clock.mockRestore() };
    }

    it('makes no delete once its attempt is killed between the Secret and the Job delete', async () => {
        const stale = leftoverOf(OLD, 'uid-stale');
        const kill = new AbortController();
        const { deps, calls } = world((method, path) => {
            if (method === 'GET' && path.startsWith(JOBS)) return answer(200, { items: [stale] });
            if (method === 'DELETE' && path.includes('/secrets/')) {
                kill.abort();
                return answer(200);
            }
        });
        await deps.request('POST', CONFIGMAPS, claimBody(job));

        await expect(sweepClaimedFleets(deps, job, kill.signal)).rejects.toThrow();

        expect(deletes(calls, jobsPath(NS))).toEqual([]);
    });

    it('stops polling by elapsed time when its reads are slow, not by a count of polls', async () => {
        const slow = slowWorld(20_000, (method, path) =>
            method === 'GET' && path.startsWith(JOBS) ? answer(503) : undefined
        );
        try {
            await expect(sweepClaimedFleets(slow.deps, job, new AbortController().signal)).rejects.toThrow(
                /could not confirm the checkout empty/
            );
        } finally {
            slow.restore();
        }

        expect(slow.calls.length).toBeLessThan(REPLACE_WAIT_MS / 20_000 + 5);
    });

    it('ends a slow multi-request round at the bound: each read gets the time left and none runs past it', async () => {
        const stale = leftoverOf(OLD, 'uid-stale');
        const slow = slowWorld(REPLACE_WAIT_MS / 2, (method, path) =>
            method === 'GET' && path.startsWith(JOBS) ? answer(200, { items: [stale] }) : undefined
        );
        try {
            await expect(sweepClaimedFleets(slow.deps, job, new AbortController().signal)).rejects.toThrow();
        } finally {
            slow.restore();
        }

        expect(slow.timeouts.every((t) => t.timeoutMs !== undefined && t.timeoutMs <= REPLACE_WAIT_MS)).toBe(true);
        expect(slow.calls.some((call) => call.path === CLAIM)).toBe(false);
        expect(deletes(slow.calls)).toEqual([]);
    });
});

describe('prepare and launch around the Job POST', () => {
    const spec = (): RunnerJobSpec =>
        ({ metadata: { name: runnerName(job) }, spec: { template: {} } }) as unknown as RunnerJobSpec;

    it('creates no Job when the claim cannot be confirmed before the POST', async () => {
        const { deps, calls } = world((method, path) => (isClaimGet(method, path) ? answer(503) : undefined));

        await expect(prepare(deps, job, new AbortController().signal)).rejects.toThrow(
            /could not be confirmed before creating the runner job/
        );

        expect(posts(calls, jobsPath(NS))).toEqual([]);
        expect(deletes(calls)).toEqual([]);
    });

    it('ends the Job it created, and never resumes it, when the claim cannot be confirmed after the POST', async () => {
        let created = false;
        const { deps, calls } = world((method, path) => {
            if (method === 'POST' && path === jobsPath(NS)) created = true;
            return created && isClaimGet(method, path) ? answer(503) : undefined;
        });
        await prepare(deps, job, new AbortController().signal);

        await expect(launch(deps, job, spec(), new AbortController().signal)).rejects.toThrow(
            /could not be confirmed after creating the runner job/
        );

        expect(deletes(calls).some((call) => call.path.startsWith(jobPath(NS, runnerName(job))))).toBe(true);
        expect(
            calls.some((call) => call.method === 'PATCH' && call.path.startsWith(jobPath(NS, runnerName(job))))
        ).toBe(false);
    });

    // The claim bracket is a wait of the attempt (#869): a kill ends its reads at once, not after the patience.
    it('reads the claim no more once the attempt is killed before the POST, creating no Job', async () => {
        const kill = new AbortController();
        let reads = 0;
        const { deps, calls } = world((method, path) => {
            if (!isClaimGet(method, path)) return;
            reads += 1;
            kill.abort();
            return answer(503);
        });

        await expect(prepare(deps, job, kill.signal)).rejects.toThrow(/could not be confirmed before creating/);

        expect(reads).toBe(1);
        expect(posts(calls, jobsPath(NS))).toEqual([]);
    });

    it('reads the claim no more once the attempt is killed after the POST, and still ends the Job it created', async () => {
        const kill = new AbortController();
        let created = false;
        let reads = 0;
        const { deps, calls } = world((method, path) => {
            if (method === 'POST' && path === jobsPath(NS)) created = true;
            if (!created || !isClaimGet(method, path)) return;
            reads += 1;
            kill.abort();
            return answer(503);
        });
        await prepare(deps, job, new AbortController().signal);

        await expect(launch(deps, job, spec(), kill.signal)).rejects.toThrow(/could not be confirmed after creating/);

        expect(reads).toBe(1);
        expect(deletes(calls).some((call) => call.path.startsWith(jobPath(NS, runnerName(job))))).toBe(true);
    });

    // #869: the claim acquisition, the Job creation and its resume end on the attempt's kill too.
    const hangingOn = (deps: K8sDeps, hang: (method: string, path: string) => boolean): K8sDeps => ({
        ...deps,
        request: (method, path, body, options) =>
            hang(method, path)
                ? new Promise((_resolve, reject) => {
                      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
                  })
                : deps.request(method, path, body, options),
    });
    const endsSoon = (pending: Promise<unknown>): Promise<boolean> =>
        Promise.race([
            pending.then(
                () => true,
                () => true
            ),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
        ]);

    it('ends the claim acquisition of prepare when the attempt is killed', async () => {
        const kill = new AbortController();
        const { deps } = world();
        const pending = prepare(
            hangingOn(deps, (method, path) => method === 'POST' && path.endsWith('/configmaps')),
            job,
            kill.signal
        );
        kill.abort();
        expect(await endsSoon(pending)).toBe(true);
    });

    it('ends the Job creation of launch when the attempt is killed', async () => {
        const kill = new AbortController();
        const { deps } = world();
        await prepare(deps, job, new AbortController().signal);
        const pending = launch(
            hangingOn(deps, (method, path) => method === 'POST' && path === jobsPath(NS)),
            job,
            spec(),
            kill.signal
        );
        kill.abort();
        expect(await endsSoon(pending)).toBe(true);
    });
});
