import { describe, expect, it } from 'vitest';
import { loadDriverConfig } from '../../src/config.js';
import { assertRunnerClassRuntimes, isKataHandler } from '../../src/k8s/k8s-runtime-class.js';
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
const classesOf = (classes: Record<string, unknown>, pools: unknown[] = []) =>
    loadDriverConfig({
        EXECUTOR: 'kubernetes',
        K8S_NAMESPACE: 'factory',
        RUNNER_CLASSES: JSON.stringify(classes),
        RUNNER_DEFAULT_CLASS: 'standard',
        RUNNER_DOCKER_IMAGE: `docker:27-dind@sha256:${'0'.repeat(64)}`,
        ...(pools.length > 0 ? { RUNNER_SANDBOX_POOLS: JSON.stringify(pools) } : {}),
    });
/** The boot check over a loaded config: its classes against its sandbox pools. */
const check = (config: ReturnType<typeof classesOf>, request: K8sRequest) =>
    assertRunnerClassRuntimes(config.runnerClasses, config.sandboxPools, request);
const docker = (runtimeClassName: string) => ({ ...DOCKER_CLASS_SIZING, runtimeClassName, docker: true });
/** A sandbox pool: its taint, and the RuntimeClasses admission lets a pod tolerating it name. */
const POOL = { taint: { key: 'sandbox.example/runtime', value: 'microvm' }, runtimeClassNames: ['vm', 'shared'] };
const POOL_TOLERATION = { key: 'sandbox.example/runtime', operator: 'Equal', value: 'microvm', effect: 'NoSchedule' };
/** A non-docker class whose toleration lets it onto the sandbox pool. */
const pooled = (runtimeClassName: string | null, tolerations: unknown[] = [POOL_TOLERATION]) => ({
    ...(runtimeClassName === null ? {} : { runtimeClassName }),
    tolerations,
});
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
        await check(classesOf({ standard: {}, sandbox: docker('kata'), other: docker('vm') }), request);
        expect(paths.sort()).toEqual([
            'GET /apis/node.k8s.io/v1/runtimeclasses/kata',
            'GET /apis/node.k8s.io/v1/runtimeclasses/vm',
        ]);
    });

    it('reads nothing when no class runs a daemon', async () => {
        const { request, paths } = apiserver({});
        await check(classesOf({ standard: {}, isolated: { runtimeClassName: 'isolated' } }), request);
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
        const booting = check(classesOf({ standard: {}, dind: docker('sandbox') }), request);
        await expect(booting).rejects.toThrow(/runner class dind: RuntimeClass "sandbox"/);
        await expect(check(classesOf({ standard: {}, dind: docker('sandbox') }), request)).rejects.toThrow(reason);
    });

    it('runs before the driver claims anything: awaited ahead of the loop', () => {
        const index = readRepoFile('driver/src/index.ts');
        const check = index.indexOf('await assertRunnerClassRuntimes(');
        expect(check).toBeGreaterThan(0);
        expect(check).toBeLessThan(index.indexOf('createLoop('));
        expect(check).toBeLessThan(index.indexOf('reaper.start()'));
    });
});

/*
 * BEL-477. A sandbox pool's only fence is its taint: a class that tolerates it lands on the pool,
 * docker or not, and every pod of the class (runner, gate, service sidecars, reader, export Job)
 * runs under its RuntimeClass. So such a class needs a Kata RuntimeClass the pool lists — Kata only,
 * gVisor too is refused — and the driver refuses to boot otherwise.
 */
describe('the boot check of a class that targets a sandbox pool', () => {
    it('refuses a non-docker class that tolerates a sandbox taint and names no RuntimeClass', async () => {
        const { request, paths } = apiserver({});
        await expect(check(classesOf({ standard: {}, isolated: pooled(null) }, [POOL]), request)).rejects.toThrow(
            /runner class isolated: .*names none.*sandbox\.example\/runtime/
        );
        expect(paths).toEqual([]);
    });

    it("refuses a pool class whose RuntimeClass is not in the pool's list, reading nothing", async () => {
        const { request, paths } = apiserver({ other: runtimeClass('kata-clh') });
        await expect(check(classesOf({ standard: {}, isolated: pooled('other') }, [POOL]), request)).rejects.toThrow(
            /runner class isolated: RuntimeClass "other" — .*sandbox\.example\/runtime.*admission refuses its pods/
        );
        expect(paths).toEqual([]);
    });

    it.each(['runc', 'gvisor', 'runsc'])('refuses a pool class whose RuntimeClass handler is %s', async (handler) => {
        const { request } = apiserver({ vm: runtimeClass(handler) });
        await expect(check(classesOf({ standard: {}, isolated: pooled('vm') }, [POOL]), request)).rejects.toThrow(
            new RegExp(`runner class isolated: RuntimeClass "vm" — its handler "${handler}" is not Kata`)
        );
    });

    it('passes a pool class whose RuntimeClass handler is kata-clh, with one read', async () => {
        const { request, paths } = apiserver({ vm: runtimeClass('kata-clh') });
        await check(classesOf({ standard: {}, isolated: pooled('vm') }, [POOL]), request);
        expect(paths).toEqual(['GET /apis/node.k8s.io/v1/runtimeclasses/vm']);
    });

    it('treats a keyless Exists toleration as tolerating the pool', async () => {
        const { request } = apiserver({});
        const anything = pooled(null, [{ operator: 'Exists' }]);
        await expect(check(classesOf({ standard: {}, isolated: anything }, [POOL]), request)).rejects.toThrow(
            /runner class isolated: .*names none/
        );
    });

    it('treats an Exists toleration of the pool key, whatever its value, as tolerating the pool', async () => {
        const { request } = apiserver({});
        const anyValue = pooled(null, [{ key: POOL.taint.key, operator: 'Exists' }]);
        await expect(check(classesOf({ standard: {}, isolated: anyValue }, [POOL]), request)).rejects.toThrow(
            /runner class isolated: .*names none/
        );
    });

    it('ignores a toleration of another key or another value (Equal)', async () => {
        const { request, paths } = apiserver({});
        const elsewhere = [
            { key: 'other.example/pool', operator: 'Exists' },
            { key: POOL.taint.key, operator: 'Equal', value: 'gvisor' },
            { key: POOL.taint.key, value: 'gvisor' },
        ];
        await check(classesOf({ standard: {}, isolated: pooled(null, elsewhere) }, [POOL]), request);
        expect(paths).toEqual([]);
    });

    it.each([
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
    ])('refuses the pool class at boot on %s', async (_, answer, reason) => {
        const { request } = apiserver({ vm: answer });
        const config = classesOf({ standard: {}, isolated: pooled('vm') }, [POOL]);
        await expect(check(config, request)).rejects.toThrow(/runner class isolated: RuntimeClass "vm"/);
        await expect(check(config, request)).rejects.toThrow(reason);
    });

    it('reads each RuntimeClass once when a docker class and a pool class share it', async () => {
        const { request, paths } = apiserver({ shared: runtimeClass('kata') });
        await check(classesOf({ standard: {}, dind: docker('shared'), isolated: pooled('shared') }, [POOL]), request);
        expect(paths).toEqual(['GET /apis/node.k8s.io/v1/runtimeclasses/shared']);
    });

    it('reads nothing without pools or docker classes, even for a class that tolerates a taint', async () => {
        const { request, paths } = apiserver({});
        await check(classesOf({ standard: {}, isolated: pooled(null) }), request);
        expect(paths).toEqual([]);
    });
});
