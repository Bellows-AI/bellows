import { describe, expect, expectTypeOf, it } from 'vitest';
import { loadDriverConfig } from '../src/config.js';
import { createDockerRunner } from '../src/docker-runner.js';
import { createKubernetesRunner } from '../src/k8s-runner.js';
import type { Runner } from '../src/runner.js';

/**
 * The executor contract (issue #828): a capability both executors implement is required of every
 * runner, so the loop calls it directly and carries no "a runner without it" fallback. Only what
 * one executor genuinely lacks stays optional — docker's fence leaves nothing to release or reap.
 */

type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];

/** Every Runner member and the executors that implement it. */
const IMPLEMENTED_BY: Record<keyof Runner, 'both' | 'kubernetes'> = {
    run: 'both',
    sampleRuntime: 'both',
    deadServices: 'both',
    startServices: 'both',
    restartServices: 'both',
    kill: 'both',
    stopAgent: 'both',
    recordKill: 'both',
    pauseDeadline: 'both',
    releaseServices: 'both',
    publishGit: 'both',
    probeTree: 'both',
    adopt: 'both',
    snapshotTree: 'both',
    syncCheckout: 'both',
    finish: 'both',
    reclaimWorktree: 'both',
    runHelper: 'both',
    runGate: 'both',
    resizeGate: 'both',
    resizeReviewer: 'both',
    releaseFence: 'kubernetes',
    reapOrphanedClaim: 'kubernetes',
};

const membersFor = (executor: 'docker' | 'kubernetes'): string[] =>
    Object.entries(IMPLEMENTED_BY)
        .filter(([, by]) => by === 'both' || by === executor)
        .map(([member]) => member)
        .sort();

const docker = createDockerRunner(loadDriverConfig({}), undefined, async () => ({ stdout: '' }));
const kubernetes = createKubernetesRunner(
    loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: 'factory', RUNNER_SERVICES: '0' }),
    async () => ({ status: 200, body: '' })
);

describe('the Runner contract', () => {
    it('leaves optional only what one executor lacks', () => {
        expectTypeOf<OptionalKeys<Runner>>().toEqualTypeOf<'releaseFence' | 'reapOrphanedClaim'>();
    });

    it.each([
        ['docker', docker],
        ['kubernetes', kubernetes],
    ] as const)('%s implements exactly its capabilities, each a function', (executor, runner) => {
        expect(Object.keys(runner).sort()).toEqual(membersFor(executor));
        for (const member of Object.values(runner)) expect(member).toBeTypeOf('function');
    });
});
