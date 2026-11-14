import { describe, expect, it } from 'vitest';
import type { K8sRequest, K8sResponse } from '../../src/k8s/k8s-transport.js';
import { jobPodsPath } from '../../src/k8s/k8s-auxspec.js';
import { runnerName } from '../../src/k8s/k8s-podspec.js';
import { DOCKERD_CONTAINER } from '../../src/k8s/k8s-dockerd.js';
import { oneClass } from '../fixtures/runner-classes.js';
import { job, namespace, podName, routed, runner } from '../fixtures/k8s-suite.js';

/**
 * `Runner.dockerdRestarts` under kubernetes: one bounded read of the task pod, answering the
 * `dockerd` sidecar's restart count. A class with no daemon reads nothing; any answer that proves
 * nothing — a failed request, a non-2xx, a body that is no pod list, no live pod, no dockerd
 * status, a count that is not one — is `inconclusive`, never a count.
 */
const DOCKER_CLASS = {
    ...oneClass({ docker: true, runtimeClassName: 'gvisor' }),
    RUNNER_DOCKER_IMAGE: `docker:27-dind@sha256:${'0'.repeat(64)}`,
};
const podsPath = jobPodsPath(namespace, runnerName(job));

const podWith = (init: unknown[]): K8sResponse => ({
    status: 200,
    body: JSON.stringify({
        items: [{ metadata: { name: podName }, status: { phase: 'Running', initContainerStatuses: init } }],
    }),
});
const dockerd = (restartCount: unknown) => ({
    name: DOCKERD_CONTAINER,
    image: 'docker:27-dind',
    restartCount,
    state: { running: {} },
});

function readWith(answer: () => K8sResponse | Promise<K8sResponse>, env: Record<string, string> = DOCKER_CLASS) {
    const { request, calls } = routed((method, path) => (method === 'GET' && path === podsPath ? answer() : undefined));
    const read = runner(request as K8sRequest, env).dockerdRestarts?.(job, new AbortController().signal);
    return { read, podReads: () => calls.filter((call) => call.path === podsPath).length };
}

describe('the dockerd restart read (kubernetes)', () => {
    it('answers the dockerd sidecar restart count, in one pod read', async () => {
        const { read, podReads } = readWith(() => podWith([dockerd(2)]));

        await expect(read).resolves.toEqual({ kind: 'value', value: 2 });
        expect(podReads()).toBe(1);
    });

    it('reads nothing of a class with no daemon', async () => {
        const { read, podReads } = readWith(() => podWith([dockerd(2)]), {});

        await expect(read).resolves.toEqual({ kind: 'absent' });
        expect(podReads()).toBe(0);
    });

    it.each<[string, () => K8sResponse | Promise<K8sResponse>]>([
        ['a failed request', () => Promise.reject(new Error('connection reset'))],
        ['a 503', () => ({ status: 503, body: 'unavailable' })],
        ['a null body', () => ({ status: 200, body: 'null' })],
        ['a body that is no JSON', () => ({ status: 200, body: '{"items":' })],
        ['an empty pod list', () => ({ status: 200, body: '{"items":[]}' })],
        ['a pod listing no dockerd', () => podWith([])],
        ['a restart count below zero', () => podWith([dockerd(-1)])],
        ['a restart count that is no number', () => podWith([dockerd('2')])],
    ])('answers %s as inconclusive, never a count', async (_name, answer) => {
        const { read } = readWith(answer);

        await expect(read).resolves.toMatchObject({ kind: 'inconclusive' });
    });
});
