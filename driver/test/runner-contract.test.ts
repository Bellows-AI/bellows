import { describe, expect, expectTypeOf, it } from 'vitest';
import { loadDriverConfig } from '../src/config.js';
import { createDockerRunner } from '../src/docker/docker-runner.js';
import { createKubernetesRunner } from '../src/k8s/k8s-runner.js';
import { jobPath } from '../src/k8s/k8s-auxspec.js';
import { runnerJobName } from '../src/k8s/k8s-podspec.js';
import type { BoardJob } from '../src/board/board.js';
import { onOwnGroup, ownGroup, type Runner } from '../src/runner.js';

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
    agentStarted: 'both',
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
    probeNoChange: 'both',
    adopt: 'both',
    snapshotTree: 'both',
    syncCheckout: 'both',
    finish: 'both',
    reclaimWorktree: 'both',
    runHelper: 'both',
    runGate: 'both',
    resizeGate: 'both',
    resizeReviewer: 'both',
    runReview: 'both',
    rebind: 'both',
    supervisorServing: 'both',
    abandon: 'both',
    releaseFence: 'kubernetes',
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
        expectTypeOf<OptionalKeys<Runner>>().toEqualTypeOf<'releaseFence'>();
    });

    it.each([
        ['docker', docker],
        ['kubernetes', kubernetes],
    ] as const)('%s implements exactly its capabilities, each a function', (executor, runner) => {
        expect(Object.keys(runner).sort()).toEqual(membersFor(executor));
        for (const member of Object.values(runner)) expect(member).toBeTypeOf('function');
    });

    it.each([
        ['docker', docker],
        ['kubernetes', kubernetes],
    ] as const)(
        '%s addresses every attempt-scoped member through the group a taken-over attempt took (#829)',
        async (_executor, runner) => {
            const seen: Record<string, BoardJob> = {};
            const recording: Record<string, unknown> = {};
            for (const name of Object.keys(runner))
                recording[name] = async (job: BoardJob) => {
                    seen[name] = job;
                };
            const taken = { id: 'j', leaseToken: 'new', groupLease: 'prior' } as BoardJob;
            const wrapped = onOwnGroup(recording as unknown as Runner) as unknown as Record<
                string,
                (job: BoardJob) => Promise<void>
            >;
            for (const name of Object.keys(wrapped)) await wrapped[name]?.(taken);

            // The runner-level members that name the claim (not a group) keep the job as the loop holds it.
            const claimScoped = ['adopt', 'syncCheckout', 'reclaimWorktree', 'rebind', 'supervisorServing'];
            for (const [name, job] of Object.entries(seen)) {
                if (claimScoped.includes(name)) expect(job, name).toBe(taken);
                else expect(job, name).toEqual(ownGroup(taken));
            }
            expect(ownGroup(taken)).toMatchObject({ leaseToken: 'prior', claimHolder: 'new' });
            expect(ownGroup({ id: 'j', leaseToken: 'x' } as BoardJob).leaseToken).toBe('x');
        }
    );

    describe("the real members reach the prior group and the new holder's claim (#829)", () => {
        const ID = '11111111-1111-4111-8111-111111111111';
        const PRIOR = '22222222-2222-4222-8222-222222222222';
        const NEW = '99999999-9999-4999-8999-999999999999';
        const taken = {
            id: ID,
            leaseToken: NEW,
            groupLease: PRIOR,
            claimSeq: 2,
            executorType: 'claude-code',
        } as BoardJob;
        const priorJob = { ...taken, leaseToken: PRIOR } as BoardJob;

        it('docker: kill names the prior lease and never the new one', async () => {
            const calls: string[][] = [];
            const runner = createDockerRunner(loadDriverConfig({}), undefined, async (args) => {
                calls.push(args);
                return { stdout: '' };
            });

            await runner.kill(taken);

            const named = calls.flat().join(' ');
            expect(named).toContain(PRIOR);
            expect(named).not.toContain(NEW);
        });

        it("kubernetes: kill ends the prior lease's Job and hands back the claim only to the new holder", async () => {
            const requests: { method: string; path: string }[] = [];
            const runner = createKubernetesRunner(
                loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: 'factory', RUNNER_SERVICES: '0' }),
                async (method, path) => {
                    requests.push({ method, path });
                    if (path.includes('/configmaps/')) {
                        return {
                            status: 200,
                            body: JSON.stringify({
                                metadata: { uid: 'claim-uid' },
                                data: { holder: NEW, claimSeq: '2' },
                            }),
                        };
                    }
                    return { status: 404, body: '{"kind":"Status"}' };
                }
            );

            await runner.kill(taken);

            expect(requests.some((r) => r.path.startsWith(jobPath('factory', runnerJobName(priorJob))))).toBe(true);
            expect(requests.some((r) => r.path.includes(runnerJobName({ ...taken, leaseToken: NEW })))).toBe(false);
            // The claim is the new holder's: given back once the prior group's end is confirmed.
            expect(requests.some((r) => r.method === 'DELETE' && r.path.includes('/configmaps/'))).toBe(true);
        });
    });
});
