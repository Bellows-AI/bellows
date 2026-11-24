import { describe, expect, it, vi } from 'vitest';
import { createBoard } from '../../src/board/board.js';
import { createLoop } from '../../src/loop/loop.js';
import type { Runner } from '../../src/runner.js';
import { labelDaemon, dockerRunner, fakeSteps as dockerSteps, spawnChild } from '../fixtures/docker-suite.js';
import { fakeRequest, fakeSteps as k8sSteps, runner as k8sRunner } from '../fixtures/k8s-suite.js';
import { config, job, ok, sleep, stubGateStack, stubRunner } from '../fixtures/loop-stubs.js';

/**
 * Amendments A2/A3 through the code that would act on a claim: a claim whose repo ref is malformed (a dot
 * host, a nested GitHub path, a bare label) goes through the real board client and the real poll loop, with only
 * the HTTP boundary and each runner's own boundary faked. It must start nothing — no sync, no git, no token ask, no
 * service, no gate, no verdict — and be left to its lease: the board is asked for work again and nothing else.
 */
const MALFORMED_REPOS: [string, unknown][] = [
    ['a dot host', { forge: 'gitlab', host: '.', path: 'o/n' }],
    ['a dot-dot host', { forge: 'gitlab', host: '..', path: 'o/n' }],
    ['a dot-dot host with a port', { forge: 'gitlab', host: '..:8443', path: 'o/n' }],
    ['a nested GitHub path', { forge: 'github', host: 'github.com', path: 'g/sub/p' }],
    ['a bare label', 'Bellows-AI/bellows'],
];

/** Polls the real board client over a fake fetch that serves `wire` once, then answers idle and stops the loop. */
async function pollOnce(wire: unknown, runner: Runner, gates = stubGateStack().gates) {
    const paths: string[] = [];
    const malformed: string[][] = [];
    let served = false;
    let loop: ReturnType<typeof createLoop> | undefined;
    const board = createBoard({
        url: 'http://board',
        leaseSeconds: 300,
        onMalformedClaim: (fields) => malformed.push(fields),
        fetch: (async (input: string | URL | Request) => {
            const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
            paths.push(path);
            if (path === '/api/jobs/claim' && !served) {
                served = true;
                return new Response(JSON.stringify(wire), { status: 200 });
            }
            if (path === '/api/jobs/claim') queueMicrotask(() => loop?.stop());
            return new Response(null, { status: 204 });
        }) as unknown as typeof globalThis.fetch,
    });
    loop = createLoop({ board, runner, config: config({}), sleep, gates });
    await loop.start();
    return { paths, malformed };
}

describe.each(MALFORMED_REPOS)('a claim with %s', (_name, repo) => {
    const wire = { ...job(1), repo };
    const onlyPolls = (paths: string[]) => {
        expect(paths.length).toBeGreaterThan(1);
        expect(paths.filter((p) => p !== '/api/jobs/claim' && p !== '/api/reclaims/claim')).toEqual([]);
    };

    it('starts nothing under a scripted runner and is left to its lease', async () => {
        let ran = 0;
        const runner = stubRunner(async () => {
            ran += 1;
            return ok();
        });
        const stack = stubGateStack();

        const { paths, malformed } = await pollOnce(wire, runner, stack.gates);

        expect(malformed).toHaveLength(1);
        expect(ran).toBe(0);
        expect(runner.synced).toHaveLength(0);
        expect(runner.startedServices).toEqual([]);
        expect(stack.stack.acquired).toEqual([]);
        // No token ask, no heartbeat, no gate report, no completion verdict: only polls reached the board.
        onlyPolls(paths);
    });

    it('starts no container, git or step under the docker executor', async () => {
        const daemon = labelDaemon();
        const spawned = vi.fn(spawnChild('', '', 0));
        const steps = dockerSteps();
        const runner = dockerRunner(daemon.exec, { spawn: spawned as never, steps: steps.sink });

        const { paths, malformed } = await pollOnce(wire, runner);

        expect(malformed).toHaveLength(1);
        expect(daemon.calls).toEqual([]);
        expect(spawned).not.toHaveBeenCalled();
        expect(steps.submitted).toEqual([]);
        onlyPolls(paths);
    });

    it('creates no pod, Job, Secret or step under the kubernetes executor', async () => {
        const api = fakeRequest();
        const steps = k8sSteps();
        const runner = k8sRunner(api.request, {}, undefined, steps.sink);

        const { paths, malformed } = await pollOnce(wire, runner);

        expect(malformed).toHaveLength(1);
        expect(api.calls).toEqual([]);
        expect(steps.submitted).toEqual([]);
        onlyPolls(paths);
    });
});
