import { describe, expect, it } from 'vitest';
import { loadDriverConfig } from '../../src/config.js';
import { assertDockerClassesOnKata, isKataHandler } from '../../src/k8s/k8s-runtime-class.js';
import type { K8sRequest, K8sResponse } from '../../src/k8s/k8s-transport.js';
import { readRepoFile } from '../fixtures/repo-files.js';
import { DOCKER_CLASS_SIZING } from '../fixtures/runner-classes.js';

/*
 * A docker class runs `dockerd` privileged: only a microVM RuntimeClass makes that root of a guest
 * kernel and not the node's. Admission trusts the class's RuntimeClass NAME; the driver reads each
 * docker class's RuntimeClass at boot and refuses to start unless its handler is Kata. A read that
 * is missing, refused, malformed or failed is no proof, so it refuses too (an unconfirmed read
 * never passes).
 */
const classesOf = (classes: Record<string, unknown>) =>
    loadDriverConfig({
        EXECUTOR: 'kubernetes',
        K8S_NAMESPACE: 'factory',
        RUNNER_CLASSES: JSON.stringify(classes),
        RUNNER_DEFAULT_CLASS: 'standard',
        RUNNER_DOCKER_IMAGE: `docker:27-dind@sha256:${'0'.repeat(64)}`,
    }).runnerClasses;
const docker = (runtimeClassName: string) => ({ ...DOCKER_CLASS_SIZING, runtimeClassName, docker: true });
const runtimeClass = (handler: unknown): K8sResponse => ({
    status: 200,
    body: JSON.stringify({ apiVersion: 'node.k8s.io/v1', kind: 'RuntimeClass', metadata: { name: 'x' }, handler }),
});
/** A fake apiserver answering each RuntimeClass GET from `answers`, recording the paths read. */
const apiserver = (answers: Record<string, K8sResponse | Error>) => {
    const paths: string[] = [];
    const request: K8sRequest = async (method, path) => {
        paths.push(`${method} ${path}`);
        const name = path.split('/').pop()!;
        const answer = answers[name] ?? { status: 404, body: '{"kind":"Status","reason":"NotFound"}' };
        if (answer instanceof Error) throw answer;
        return answer;
    };
    return { request, paths };
};

describe('the Kata handler rule', () => {
    it.each(['kata', 'kata-clh', 'kata-qemu', 'kata-fc', 'kata-qemu-snp'])('accepts %s', (handler) => {
        expect(isKataHandler(handler)).toBe(true);
    });
    it.each(['runc', 'crun', 'youki', 'katana', 'my-kata', '', 'KATA'])('refuses %s', (handler) => {
        expect(isKataHandler(handler)).toBe(false);
    });
});

describe('the boot check of a docker class RuntimeClass', () => {
    it('reads each docker class RuntimeClass and passes a Kata handler', async () => {
        const { request, paths } = apiserver({ kata: runtimeClass('kata-clh'), vm: runtimeClass('kata') });
        await assertDockerClassesOnKata(
            classesOf({ standard: {}, sandbox: docker('kata'), other: docker('vm') }),
            request
        );
        expect(paths.sort()).toEqual([
            'GET /apis/node.k8s.io/v1/runtimeclasses/kata',
            'GET /apis/node.k8s.io/v1/runtimeclasses/vm',
        ]);
    });

    it('reads nothing when no class runs a daemon', async () => {
        const { request, paths } = apiserver({});
        await assertDockerClassesOnKata(
            classesOf({ standard: {}, isolated: { runtimeClassName: 'isolated' } }),
            request
        );
        expect(paths).toEqual([]);
    });

    it.each([
        ['a non-Kata handler', runtimeClass('runc'), 'its handler "runc" is not Kata'],
        ['a missing RuntimeClass', { status: 404, body: '{"kind":"Status","reason":"NotFound"}' }, 'does not exist'],
        [
            'a forbidden read',
            { status: 403, body: '{"kind":"Status","message":"forbidden","reason":"Forbidden"}' },
            '403',
        ],
        ['a body that is not JSON', { status: 200, body: '<html>' }, 'not JSON'],
        ['a RuntimeClass without a handler', runtimeClass(undefined), 'unexpected shape'],
        ['a handler that is not a string', runtimeClass(7), 'unexpected shape'],
        ['a failed read', new Error('connect ECONNREFUSED'), 'ECONNREFUSED'],
    ])('refuses the docker class at boot on %s', async (_, answer, reason) => {
        const { request } = apiserver({ sandbox: answer });
        const check = assertDockerClassesOnKata(classesOf({ standard: {}, dind: docker('sandbox') }), request);
        await expect(check).rejects.toThrow(/runner class dind: RuntimeClass "sandbox"/);
        await expect(
            assertDockerClassesOnKata(classesOf({ standard: {}, dind: docker('sandbox') }), request)
        ).rejects.toThrow(reason);
    });

    it('runs before the driver claims anything: awaited ahead of the loop', () => {
        const index = readRepoFile('driver/src/index.ts');
        const check = index.indexOf('await assertDockerClassesOnKata(');
        expect(check).toBeGreaterThan(0);
        expect(check).toBeLessThan(index.indexOf('createLoop('));
        expect(check).toBeLessThan(index.indexOf('reaper.start()'));
    });
});
