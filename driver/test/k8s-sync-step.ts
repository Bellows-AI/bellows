import type { Board, BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { createKubernetesRunner } from '../src/k8s-runner.js';
import type { K8sMethod, K8sRequest, K8sResponse } from '../src/k8s-transport.js';
import type { StepSink } from '../src/step-control.js';
import { taskVolumeServer } from './fixtures/k8s-apiserver.js';
import { type StepRequest, SUPERVISOR_ENV } from '../src/supervisor-contract.js';

/**
 * The sync step the kubernetes runner submits to the attempt's supervisor for `job` (issue #771),
 * over a fake apiserver that keeps the checkout claim honest and answers every other object a
 * group's creation touches. For the suites that pin what the startup sync CARRIES on both
 * executors — its env, never its argv — and need no more of the cluster than that.
 */
export async function k8sSyncStep(job: BoardJob, githubToken?: string): Promise<StepRequest> {
    const { steps } = await k8sSyncRun(job, { githubToken });
    const sync = steps.find((step) => step.kind === 'sync');
    if (!sync) throw new Error('the kubernetes runner submitted no sync step');
    return sync;
}

/**
 * The whole `syncCheckout` of `job` over the same fake apiserver: every step submitted (answered by
 * `answer`, a clean sync by default), every apiserver call in order, and the result the runner returned
 * or the error it threw. `claims` seeds the task volume claims the apiserver already holds (a PVC
 * manifest each); `checkpoints` is the board's checkpoint read.
 */
export async function k8sSyncRun(
    job: BoardJob,
    {
        githubToken,
        answer = () => '{"ok":true,"reason":null}',
        volumes = [],
        checkpoints,
    }: {
        githubToken?: string | undefined;
        answer?: (step: StepRequest) => string;
        volumes?: unknown[];
        checkpoints?: Pick<Board, 'checkpoint'>;
    } = {}
) {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const claims = new Map<string, unknown>();
    // The default namespace of the config below, which names none.
    const serveVolumes = taskVolumeServer('default');
    for (const volume of volumes) serveVolumes('POST', '/api/v1/namespaces/default/persistentvolumeclaims', volume);
    const json = (body: unknown, status = 200): K8sResponse => ({ status, body: JSON.stringify(body) });
    const request: K8sRequest = async (method: K8sMethod, path: string, body?: unknown) => {
        calls.push({ method, path, body });
        if (path.includes('/configmaps')) {
            const name = path.split('/configmaps/')[1];
            if (method === 'POST') {
                const claim = body as { metadata: { name: string }; data: unknown };
                claims.set(claim.metadata.name, claim.data);
                return json({}, 201);
            }
            if (method === 'DELETE') return json({});
            return claims.has(name ?? '')
                ? json({ metadata: { uid: 'claim-uid' }, data: claims.get(name ?? '') })
                : { status: 404, body: '{}' };
        }
        const volume = serveVolumes(method, path, body);
        if (volume) return volume;
        // Created, as the apiserver answers: the uid a Secret's owner reference names.
        if (method === 'POST') return json({ metadata: { uid: 'object-uid' } }, 201);
        // The sweep's selector lists: nothing of this job is left over.
        if (method === 'GET' && path.includes('labelSelector')) return json({ items: [] });
        return json({});
    };
    const steps: StepRequest[] = [];
    const sink: StepSink = {
        submit: async (_token, step) => {
            steps.push(step);
            return { exitCode: 0, stdout: answer(step), stderr: '', timedOut: false };
        },
        awaitReport: () => new Promise(() => undefined),
        contacted: () => true,
        release: () => undefined,
        attach: () => undefined,
        cancel: () => undefined,
    };
    const supervised: BoardJob = {
        ...job,
        supervisorEnv: { [SUPERVISOR_ENV.controlUrl]: 'http://driver:8130', [SUPERVISOR_ENV.controlToken]: 'tok' },
    };
    const runner = createKubernetesRunner(
        loadDriverConfig({ EXECUTOR: 'kubernetes', RUNNER_SERVICES: '0' }),
        request,
        async () => undefined,
        { steps: sink, ...(checkpoints ? { checkpoints } : {}) }
    );
    const result = await runner
        .syncCheckout(supervised, undefined, { id: '33333333-3333-4333-8333-333333333333', resume: false }, githubToken)
        .then(
            (value) => ({ value }),
            (error: unknown) => ({ error })
        );
    return { steps, calls, ...result, job: supervised };
}
