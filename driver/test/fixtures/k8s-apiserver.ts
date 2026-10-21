/**
 * The fake kubernetes API server the runner suites test against: a router over (method, path) whose
 * unscripted calls reject, so a test that passes is one whose every call was accounted for. A factory
 * because the runner pod log route is named for one job: a test whose world mints its own ids builds
 * its own server; `k8s.test.ts` builds one for its fixture job.
 */
import type { K8sMethod, K8sRequest, K8sResponse } from '../../src/k8s-transport.js';
import { jobsPath } from '../../src/k8s-podspec.js';

export interface Call {
    method: string;
    path: string;
    body?: unknown;
}

/** A test's own routes, tried before fakeRequest's; `undefined` falls through to them. */
export type Special = (
    method: K8sMethod,
    path: string,
    body: unknown
) => K8sResponse | Promise<K8sResponse> | undefined;

/**
 * The thread's task volume claims (issue #775), emulated the way the apiserver arbitrates them: a GET
 * reads 404 until a POST stores the claim, and a second POST of the same name answers 409. Answers
 * `undefined` for any path that is not a claim's, so a suite's own routes stay in charge of the rest.
 */
export function taskVolumeServer(namespace: string) {
    const volumes = new Map<string, string>();
    const volumesPath = `/api/v1/namespaces/${namespace}/persistentvolumeclaims`;
    return (method: K8sMethod, path: string, body?: unknown): K8sResponse | undefined => {
        if (path === volumesPath && method === 'POST') {
            const name = (body as { metadata: { name: string } }).metadata.name;
            if (volumes.has(name)) return { status: 409, body: '{"kind":"Status","reason":"AlreadyExists"}' };
            volumes.set(name, JSON.stringify(body));
            return { status: 201, body: volumes.get(name)! };
        }
        if (path.startsWith(`${volumesPath}/`) && method === 'GET') {
            const stored = volumes.get(path.slice(volumesPath.length + 1));
            return stored === undefined
                ? { status: 404, body: '{"kind":"Status","reason":"NotFound"}' }
                : { status: 200, body: stored };
        }
        return undefined;
    };
}

/** One fake API server for `namespace`, serving the runner pod log under `podName`. */
export function k8sApiserver({ namespace, podName }: { namespace: string; podName: string }) {
    const configmapsPath = `/api/v1/namespaces/${namespace}/configmaps`;

    const FAKE: Record<string, unknown> = {
        // A created object, as the apiserver answers it: the uid a Secret's owner reference names.
        create: { status: 201, body: JSON.stringify({ metadata: { uid: 'job-uid-1' } }) },
        // The fence: a label LIST that answers empty (nothing left to delete). fenceDelete stays
        // only so an unexpected collection DELETE still gets an answer instead of a route miss.
        fenceDelete: { status: 200, body: '{}' },
        fenceList: { status: 200, body: '{"items":[]}' },
        // A read Job, as the apiserver answers it: the uid the create above handed out.
        job: { status: 200, body: JSON.stringify({ metadata: { uid: 'job-uid-1' }, status: { succeeded: 1 } }) },
        failed: {
            status: 200,
            body: JSON.stringify({
                metadata: { uid: 'job-uid-1' },
                status: { failed: 1, conditions: [{ type: 'Failed', reason: 'DeadlineExceeded' }] },
            }),
        },
        pods: {
            status: 200,
            body: JSON.stringify({
                items: [
                    {
                        metadata: { name: podName },
                        // Ran to its end: an adoption takes no pod still running for a group over (#824).
                        status: {
                            phase: 'Succeeded',
                            containerStatuses: [{ name: 'agent', state: { terminated: { exitCode: 0 } } }],
                        },
                    },
                ],
            }),
        },
        log: { status: 200, body: 'did the work\n' },
        secretCreate: { status: 201, body: JSON.stringify({ metadata: { uid: 'secret-uid-1' } }) },
        secretDelete: { status: 200, body: '{}' },
    };

    /** A request function that answers from FAKE, or throws if the test did not script the call. */
    const fakeRequest = (overrides: Record<string, unknown> = {}): { request: K8sRequest; calls: Call[] } => {
        const calls: Call[] = [];
        const answers = { ...FAKE, ...overrides };
        const secretsPath = `/api/v1/namespaces/${namespace}/secrets`;
        // The checkout claim, emulated the way the apiserver arbitrates it: name uniqueness on POST,
        // a readable GET, a uid-preconditioned DELETE (see claimServer).
        const serve = claimServer();
        // A Job deleted by name reads 404 from then on, as the apiserver answers once its Foreground
        // deletion lands (issue #821: a teardown confirms it); a POST of the same name brings it back.
        const deletedJobs = new Set<string>();
        // A Job never created reads 404 too — what a derived name's teardown reads before it ends anything.
        const postedJobs = new Set<string>();
        const serveVolumes = taskVolumeServer(namespace);
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            const claimAnswer = serve(method, path, body);
            if (claimAnswer) return Promise.resolve(claimAnswer);
            const volumeAnswer = serveVolumes(method, path, body);
            if (volumeAnswer) return Promise.resolve(volumeAnswer);
            if (path === jobsPath(namespace) && method === 'POST') {
                const posted = (body as { metadata?: { name?: string } } | undefined)?.metadata?.name;
                const answer = answers.create as K8sResponse;
                if (posted && answer.status < 300) {
                    deletedJobs.delete(posted);
                    postedJobs.add(posted);
                }
                return Promise.resolve(answer);
            }
            if (
                path.startsWith(`${jobsPath(namespace)}/`) &&
                !path.slice(jobsPath(namespace).length + 1).includes('/')
            ) {
                const name = path.slice(jobsPath(namespace).length + 1).split('?')[0]!;
                if (method === 'DELETE') deletedJobs.add(name);
                else if (
                    method === 'GET' &&
                    (deletedJobs.has(name) || (name.startsWith('factory-reclaim-') && !postedJobs.has(name)))
                ) {
                    return Promise.resolve({ status: 404, body: '{"kind":"Status","reason":"NotFound"}' });
                } else if (method === 'PATCH') {
                    // A merge patch (a resume, a suspend, a deadline, a kill record) lands on a Job that exists.
                    return Promise.resolve(
                        deletedJobs.has(name) ? { status: 404, body: '{"kind":"Status"}' } : { status: 200, body: '{}' }
                    );
                }
            }
            if (path.startsWith(`${jobsPath(namespace)}?`)) {
                if (method === 'DELETE') return Promise.resolve(answers.fenceDelete as K8sResponse);
                return Promise.resolve(answers.fenceList as K8sResponse);
            }
            if (path === secretsPath) {
                if (method === 'DELETE') return Promise.resolve(answers.secretDelete as K8sResponse);
                return Promise.resolve(answers.secretCreate as K8sResponse);
            }
            if (path.startsWith(`${secretsPath}/`)) return Promise.resolve(answers.secretDelete as K8sResponse);
            // Any attempt's Job: names carry the lease token now, so a run's own status poll targets
            // a path built from ITS token, not the fixture job's.
            if (path.startsWith(`${jobsPath(namespace)}/`)) return Promise.resolve(answers.job as K8sResponse);
            // Service objects: lists answer empty (nothing to sweep, nothing to tear down), a POST
            // creates one, a delete succeeds. Overrides script the interesting cases.
            const servicesPath = `/api/v1/namespaces/${namespace}/services`;
            if (path === servicesPath) {
                if (method === 'DELETE') return Promise.resolve(answers.fenceDelete as K8sResponse);
                return Promise.resolve((answers.serviceCreate ?? { status: 201, body: '{}' }) as K8sResponse);
            }
            if (path.startsWith(`${servicesPath}?`)) return Promise.resolve(answers.fenceList as K8sResponse);
            if (path.startsWith(`${servicesPath}/`)) return Promise.resolve(answers.fenceDelete as K8sResponse);
            if (
                path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) &&
                decodeURIComponent(path).includes('job-name=')
            ) {
                return Promise.resolve(answers.pods as K8sResponse);
            }
            if (
                path.startsWith(`/api/v1/namespaces/${namespace}/pods/`) &&
                !path.endsWith('/log') &&
                method === 'DELETE'
            ) {
                return Promise.resolve(answers.fenceDelete as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods/${podName}/log`)) {
                return Promise.resolve(answers.log as K8sResponse);
            }
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };
        return { request, calls };
    };

    /**
     * fakeRequest with the routes a test is about in front of it: `special` answers first, and
     * anything it leaves (`undefined`) falls through to fakeRequest — whose claim server, Job,
     * pod, log, Secret and aux routes answer as usual, and whose unscripted paths still reject.
     * Every call is recorded, the ones `special` answered included.
     */
    const routed = (
        special: Special,
        overrides: Record<string, unknown> = {}
    ): { request: K8sRequest; calls: Call[] } => {
        const calls: Call[] = [];
        const base = fakeRequest(overrides);
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            const answer = special(method, path, body);
            return answer === undefined ? base.request(method, path, body) : Promise.resolve(answer);
        };
        return { request, calls };
    };

    /**
     * Default answers for the objects the runner touches beyond the runner Job itself: the fence
     * sweeps service pods and headless Services by the job label, the lease teardown lists them,
     * and aux Jobs (gates, the .bellows.yaml readout) ride the same Job routes the tests script.
     * fakeRequest (and so every routed fake) falls through to this before rejecting, so a test only scripts the
     * objects it is about. Lists answer empty — nothing to sweep, nothing to tear down.
     */
    const AUX = {
        list: { status: 200, body: '{"items":[]}' },
        delete: { status: 200, body: '{}' },
        create: { status: 201, body: '{}' },
    } satisfies Record<string, K8sResponse>;
    function auxRoutes(method: string, path: string): K8sResponse | null {
        const ns = `/api/v1/namespaces/${namespace}`;
        if (path === `${ns}/services`) {
            if (method === 'DELETE') return AUX.delete;
            if (method === 'POST') return AUX.create;
            return AUX.list;
        }
        if (path.startsWith(`${ns}/services?`)) return AUX.list;
        if (path.startsWith(`${ns}/services/`)) return AUX.delete;
        // Every pod list EXCEPT the runner's job-name discovery (those are routed by the routers
        // above): the fence's sweep and the lease teardown answer empty — nothing of this job's.
        if (path.startsWith(`${ns}/pods?`)) return AUX.list;
        if (path.startsWith(`${ns}/pods/`) && !path.endsWith('/log') && method === 'DELETE') return AUX.delete;
        return null;
    }

    /**
     * A minimal API server for the checkout claim: ConfigMap NAME uniqueness arbitrates (a POST of a
     * taken name answers 409), a GET reads the stored claim, and a DELETE honors uid preconditions —
     * exactly the three apiserver properties the acquire/takeover/release protocol rests on.
     */
    const claimServer = () => {
        const claims = new Map<
            string,
            { uid: string; data: Record<string, string>; created: string; annotations: Record<string, string> }
        >();
        let uids = 0;
        return (method: K8sMethod, path: string, body: unknown): K8sResponse | undefined => {
            if (method === 'POST' && path === configmapsPath) {
                const b = body as { metadata?: { name?: string }; data?: { holder?: string; claimSeq?: string } };
                const name = b.metadata?.name ?? '';
                if (claims.has(name)) return { status: 409, body: '{"reason":"AlreadyExists"}' };
                claims.set(name, {
                    uid: `claim-uid-${++uids}`,
                    // The apiserver stores `data` as written: a key the writer left out is absent.
                    data: { ...b.data },
                    // The apiserver stamps this on every object; the orphaned-claim readout (issue
                    // #344) reports the claim's age from it.
                    created: new Date().toISOString(),
                    annotations: {},
                });
                return { status: 201, body: '{}' };
            }
            if (path?.startsWith(`${configmapsPath}/`)) {
                const name = path.slice(configmapsPath.length + 1);
                const claim = claims.get(name);
                if (method === 'GET') {
                    return claim
                        ? {
                              status: 200,
                              body: JSON.stringify({
                                  metadata: {
                                      uid: claim.uid,
                                      creationTimestamp: claim.created,
                                      annotations: claim.annotations,
                                  },
                                  data: claim.data,
                              }),
                          }
                        : { status: 404, body: '{"kind":"Status"}' };
                }
                if (method === 'DELETE') {
                    const want = (body as { preconditions?: { uid?: string } } | undefined)?.preconditions?.uid;
                    if (claim && (!want || want === claim.uid)) {
                        claims.delete(name);
                        return { status: 200, body: '{}' };
                    }
                    return { status: claim ? 409 : 404, body: '{"kind":"Status"}' };
                }
                if (method === 'PATCH') {
                    // A merge patch whose `metadata.uid` names another incarnation is refused, as the
                    // apiserver refuses a uid it cannot match.
                    const patch = body as
                        | { metadata?: { uid?: string; annotations?: Record<string, string> } }
                        | undefined;
                    if (!claim) return { status: 404, body: '{"kind":"Status"}' };
                    if (patch?.metadata?.uid && patch.metadata.uid !== claim.uid) {
                        return { status: 409, body: '{"kind":"Status"}' };
                    }
                    Object.assign(claim.annotations, patch?.metadata?.annotations ?? {});
                    return { status: 200, body: '{}' };
                }
            }
            return undefined;
        };
    };

    return { FAKE, AUX, auxRoutes, claimServer, fakeRequest, routed };
}
