/**
 * The re-claim fence (`k8s-fence.ts`) called directly, its own functions rather than through a
 * runner: the claim, its revocation and release, the sweep, and the pre/post-create verifies. What
 * a runner-level scenario in `k8s.test.ts` already pins (a stale claim taken over by uid, the Secret
 * before the Job, the uid on every delete, the resume by uid) is not repeated here. Assertions are on
 * requests and on what is thrown or answered, never on how many times a read was retried.
 */
import { describe, expect, it } from 'vitest';
import type { BoardJob, BoardLease } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { claimBody, claimPath, configmapsPath, jobPath } from '../src/k8s-auxspec.js';
import {
    acquireClaim,
    launch,
    prepare,
    readClaim,
    releaseClaimAfterGroupEnd,
    revokeClaim,
    sweepClaimedFleets,
} from '../src/k8s-fence.js';
import { jobsPath, runnerJobName, runnerName, type RunnerJobSpec, secretName } from '../src/k8s-podspec.js';
import { CLAIM_ROUNDS, type K8sDeps, type K8sResponse } from '../src/k8s-transport.js';
import { REVOKED_MARK } from '../src/labels.js';
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

    it('names the incarnation and its holder, and whether the claim was revoked', async () => {
        const plain = world((method, path) =>
            isClaimGet(method, path) ? answer(200, claimBodyOf({ uid: 'u-1', holder: OLD })) : undefined
        );
        const revoked = world((method, path) =>
            isClaimGet(method, path)
                ? answer(200, claimBodyOf({ uid: 'u-2', holder: OLD, annotations: { [REVOKED_MARK]: job.leaseToken } }))
                : undefined
        );

        expect(await readClaim(plain.deps, job)).toEqual({ uid: 'u-1', holder: OLD, revoked: false });
        expect(await readClaim(revoked.deps, job)).toEqual({ uid: 'u-2', holder: OLD, revoked: true });
    });
});

describe('revokeClaim', () => {
    const observed = { uid: 'uid-seen', holder: OLD };

    it('patches the observed uid with this lease token as the revoked mark', async () => {
        const { deps, calls } = world((method, path) =>
            method === 'PATCH' && path === CLAIM ? answer(200) : undefined
        );

        expect(await revokeClaim(deps, job, observed)).toBe(true);

        expect(calls).toEqual([
            {
                method: 'PATCH',
                path: CLAIM,
                body: { metadata: { uid: 'uid-seen', annotations: { [REVOKED_MARK]: job.leaseToken } } },
            },
        ]);
    });

    it.each<[string, Special]>([
        ['a replaced claim (409)', () => answer(409)],
        ['a gone claim (404)', () => answer(404)],
        ['an apiserver error (503)', () => answer(503)],
        ['a transport failure', () => Promise.reject(new Error('socket hang up'))],
    ])('revokes nothing on %s', async (_label, special) => {
        const { deps } = world((method, path, body) => (method === 'PATCH' ? special(method, path, body) : undefined));

        expect(await revokeClaim(deps, job, observed)).toBe(false);
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

        await sweepClaimedFleets(deps, job);

        expect(calls.every((call) => call.method === 'GET')).toBe(true);
        expect(calls.some((call) => call.path.startsWith(CONFIGMAPS))).toBe(false);
    });

    it('throws that it could not confirm the checkout empty, deleting nothing, when a kind never lists', async () => {
        const { deps, calls } = world((method, path) =>
            method === 'GET' && path.startsWith(JOBS) ? answer(503) : undefined
        );

        await expect(sweepClaimedFleets(deps, job)).rejects.toThrow(/could not confirm the checkout empty/);

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

        await sweepClaimedFleets(deps, job);

        const gone = deletes(calls).map((call) => call.path.split('?')[0]);
        expect(gone).toContain(jobPath(NS, older.metadata.name));
        expect(gone).toContain(
            `/api/v1/namespaces/${NS}/secrets/${secretName({ ...job, leaseToken: older.metadata.labels['factory.lease'] })}`
        );
        expect(gone.some((path) => path!.includes(adoptedJob.metadata.name))).toBe(false);
        expect(gone.some((path) => path!.endsWith(`/${secretName(earlier)}`))).toBe(false);
    });
});

describe('prepare and launch around the Job POST', () => {
    const spec = (): RunnerJobSpec =>
        ({ metadata: { name: runnerName(job) }, spec: { template: {} } }) as unknown as RunnerJobSpec;

    it('creates no Job when the claim cannot be confirmed before the POST', async () => {
        const { deps, calls } = world((method, path) => (isClaimGet(method, path) ? answer(503) : undefined));

        await expect(prepare(deps, job)).rejects.toThrow(/could not be confirmed before creating the runner job/);

        expect(posts(calls, jobsPath(NS))).toEqual([]);
        expect(deletes(calls)).toEqual([]);
    });

    it('ends the Job it created, and never resumes it, when the claim cannot be confirmed after the POST', async () => {
        let created = false;
        const { deps, calls } = world((method, path) => {
            if (method === 'POST' && path === jobsPath(NS)) created = true;
            return created && isClaimGet(method, path) ? answer(503) : undefined;
        });
        await prepare(deps, job);

        await expect(launch(deps, job, spec())).rejects.toThrow(/could not be confirmed after creating the runner job/);

        expect(deletes(calls).some((call) => call.path.startsWith(jobPath(NS, runnerName(job))))).toBe(true);
        expect(
            calls.some((call) => call.method === 'PATCH' && call.path.startsWith(jobPath(NS, runnerName(job))))
        ).toBe(false);
    });
});
