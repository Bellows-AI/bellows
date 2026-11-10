import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { job as suiteJob } from './fixtures/k8s-suite.js';
import type { StepResult } from '../src/supervisor-contract.js';
import type { ReviewRun } from '../src/review/review-step.js';

// The project shares module state across files (isolate: false): the mock is scoped to this
// file's own fresh module graph, and dropped after it, so no other file sees it.
const steps = vi.hoisted(() => ({ run: vi.fn() }));
vi.resetModules();
vi.doMock('../src/review/review-step.js', async () => ({
    ...(await vi.importActual<typeof import('../src/review/review-step.js')>('../src/review/review-step.js')),
    runReviewSteps: steps.run,
}));

const { runDockerReview } = await import('../src/docker/docker-gate.js');
const { reviewerName } = await import('../src/docker/docker-group.js');

afterAll(() => {
    vi.doUnmock('../src/review/review-step.js');
    vi.resetModules();
});

const job = { ...suiteJob, id: randomUUID(), leaseToken: randomUUID() };
const run = { caller: job } as unknown as ReviewRun;
const lost: StepResult = { exitCode: null, stdout: '', stderr: 'its loop is not running', timedOut: false };
const STATE = '{"Status":"exited","ExitCode":2,"OOMKilled":false}';
const LOG_LINE = 'sh: 1: cannot create /factory/review/alive: Permission denied';

type Call = { args: string[]; signal?: AbortSignal | undefined };
const deps = (answer: (args: string[]) => Promise<{ stdout: string; stderr?: string }>) => {
    const calls: Call[] = [];
    return {
        calls,
        deps: {
            host: async () => ({}) as never,
            execDocker: async (args: string[], options?: { signal?: AbortSignal | undefined }) => {
                calls.push({ args, signal: options?.signal });
                return answer(args);
            },
        },
    };
};
const healthy = async (args: string[]) =>
    args[0] === 'inspect' ? { stdout: STATE } : { stdout: 'a\n', stderr: `${LOG_LINE}\n` };

beforeEach(() => {
    steps.run.mockReset();
    steps.run.mockResolvedValue(lost);
});

describe('a lost docker review', () => {
    it("names the reviewer's docker state and its last log lines", async () => {
        const { deps: d, calls } = deps(healthy);
        const result = await runDockerReview(d, run);
        expect(result.exitCode).toBeNull();
        expect(result.stderr).toContain('its loop is not running');
        expect(result.stderr).toContain('the reviewer container: exited 2');
        expect(result.stderr).toContain(LOG_LINE);
        expect(calls.map((c) => c.args)).toEqual([
            ['inspect', '--format', '{{json .State}}', reviewerName(job)],
            ['logs', '--tail', '3', reviewerName(job)],
        ]);
    });

    it('an OOM-killed reviewer says so', async () => {
        const { deps: d } = deps(async (args) =>
            args[0] === 'inspect' ? { stdout: '{"Status":"exited","ExitCode":137,"OOMKilled":true}' } : { stdout: 'x' }
        );
        expect((await runDockerReview(d, run)).stderr).toContain('exited 137 (OOMKilled)');
    });

    it('a failing log read still prints the state', async () => {
        for (const logs of [
            async (): Promise<{ stdout: string }> => {
                throw new Error('daemon gone');
            },
            async () => ({ stdout: '' }),
        ]) {
            const { deps: d } = deps((args) => (args[0] === 'inspect' ? Promise.resolve({ stdout: STATE }) : logs()));
            const result = await runDockerReview(d, run);
            expect(result.stderr).toContain('the reviewer container: exited 2');
            expect(result.stderr).toContain('logs unavailable');
            expect(result.exitCode).toBeNull();
        }
    });

    it('a failing or malformed inspect still prints the tail', async () => {
        for (const inspect of [
            async (): Promise<{ stdout: string }> => {
                throw new Error('no such container');
            },
            async () => ({ stdout: 'not json' }),
            async () => ({ stdout: '{"Status":"exited"}' }),
        ]) {
            const { deps: d } = deps((args) =>
                args[0] === 'inspect' ? inspect() : Promise.resolve({ stdout: LOG_LINE })
            );
            const result = await runDockerReview(d, run);
            expect(result.stderr).toContain('state unknown:');
            expect(result.stderr).toContain(LOG_LINE);
            expect(result.exitCode).toBeNull();
        }
    });

    it('both reads share one 5 s bound', async () => {
        const { deps: d, calls } = deps(healthy);
        await runDockerReview(d, run);
        expect(calls).toHaveLength(2);
        expect(calls[0]!.signal).toBeDefined();
        expect(calls[1]!.signal).toBe(calls[0]!.signal);
    });

    it('a hanging read ends at the bound, with unknowns', async () => {
        const bound = new AbortController();
        const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(bound.signal);
        try {
            const hanging = {
                host: async () => ({}) as never,
                execDocker: (_args: string[], options?: { signal?: AbortSignal | undefined }) =>
                    new Promise<{ stdout: string }>((_, reject) => {
                        if (options?.signal?.aborted) reject(new Error('aborted'));
                        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
                    }),
            };
            const pending = runDockerReview(hanging, run);
            await new Promise((resolve) => setTimeout(resolve, 10));
            bound.abort();
            const result = await pending;
            expect(timeout).toHaveBeenCalledTimes(1);
            expect(timeout).toHaveBeenCalledWith(5_000);
            expect(result.stderr).toContain('state unknown:');
            expect(result.stderr).toContain('logs unavailable');
            expect(result.exitCode).toBeNull();
        } finally {
            timeout.mockRestore();
        }
    });

    it('an answered review is not read', async () => {
        for (const exitCode of [0, 1]) {
            steps.run.mockResolvedValue({ ...lost, exitCode });
            const { deps: d, calls } = deps(healthy);
            expect((await runDockerReview(d, run)).stderr).toBe('its loop is not running');
            expect(calls).toEqual([]);
        }
    });

    it('an aborted review is not read', async () => {
        const { deps: d, calls } = deps(healthy);
        const controller = new AbortController();
        steps.run.mockImplementation(async () => {
            controller.abort();
            return lost;
        });
        expect((await runDockerReview(d, run, controller.signal)).stderr).toBe('its loop is not running');
        expect(calls).toEqual([]);
    });
});
