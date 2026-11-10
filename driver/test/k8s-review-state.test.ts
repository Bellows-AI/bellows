import { beforeEach, describe, expect, it, vi } from 'vitest';
import { job, namespace } from './fixtures/k8s-suite.js';
import { loadDriverConfig } from '../src/config.js';
import type { K8sDeps, K8sRequest, K8sResponse } from '../src/k8s/k8s-transport.js';
import type { StepResult } from '../src/supervisor-contract.js';
import type { ReviewRun } from '../src/review/review-step.js';

const steps = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/review/review-step.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/review/review-step.js')>()),
    runReviewSteps: steps.run,
}));
vi.mock('../src/k8s/k8s-group.js', () => ({ stepHostFor: async () => ({}) }));

const { runReviewInGroup } = await import('../src/k8s/k8s-gate.js');

const run = { caller: job } as unknown as ReviewRun;
const lost: StepResult = { exitCode: null, stdout: '', stderr: 'its loop is not running', timedOut: false };
const LOG_LINE = 'sh: 1: cannot create /factory/review/alive: Permission denied';
const POD = 'task-pod';

const podList = (reviewer: unknown): K8sResponse => ({
    status: 200,
    body: JSON.stringify({
        items: [
            {
                metadata: { name: POD },
                status: {
                    initContainerStatuses:
                        reviewer === undefined ? [] : [{ name: 'reviewer', ...(reviewer as object) }],
                },
            },
        ],
    }),
});
const reviewerStatus = (restartCount: number, extra: object = {}) => ({
    restartCount,
    state: { running: {} },
    ...extra,
});

type Seen = { method: string; path: string; signal?: AbortSignal | undefined };
const harness = (list: () => K8sResponse | Promise<K8sResponse>, log: () => K8sResponse | Promise<K8sResponse>) => {
    const seen: Seen[] = [];
    const request: K8sRequest = async (method, path, _body, options) => {
        seen.push({ method, path, signal: options?.signal });
        return path.includes('/log') ? log() : list();
    };
    const deps = {
        request,
        sleep: async () => undefined,
        config: loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }),
    } as unknown as K8sDeps;
    return { deps, seen };
};
const logPath = (seen: Seen[]) => seen.find((s) => s.path.includes('/log'))?.path;

beforeEach(() => {
    steps.run.mockReset();
    steps.run.mockResolvedValue(lost);
});

describe('a lost kubernetes review', () => {
    it("names the reviewer sidecar's state and its current log tail", async () => {
        const { deps, seen } = harness(
            () => podList(reviewerStatus(0)),
            () => ({ status: 200, body: `a\n${LOG_LINE}\n` })
        );
        const result = await runReviewInGroup(deps, run);
        expect(result.exitCode).toBeNull();
        expect(result.stderr).toContain('its loop is not running');
        expect(result.stderr).toContain('the reviewer container: running');
        expect(result.stderr).toContain(LOG_LINE);
        expect(logPath(seen)).toContain('tailLines=3&container=reviewer');
        expect(logPath(seen)).not.toContain('previous');
    });

    it("a restarted sidecar's tail is the previous instance's", async () => {
        const { deps, seen } = harness(
            () => podList(reviewerStatus(2, { lastState: { terminated: { exitCode: 2, reason: 'Error' } } })),
            () => ({ status: 200, body: `${LOG_LINE}\n` })
        );
        const result = await runReviewInGroup(deps, run);
        expect(logPath(seen)).toContain('previous=true');
        expect(seen.filter((s) => s.path.includes('/log'))).toHaveLength(1);
        expect(result.stderr).toContain('before restart 2');
        expect(result.stderr).toContain('exit 2');
        expect(result.stderr).toContain(LOG_LINE);
    });

    it('a failing log read still prints the state', async () => {
        const bad: Array<() => K8sResponse | Promise<K8sResponse>> = [
            () => ({ status: 500, body: 'boom' }),
            () => ({ status: 400, body: 'no previous' }),
            () => ({ status: 200, body: '' }),
            () => Promise.reject(new Error('timeout')),
        ];
        for (const log of bad) {
            const { deps } = harness(() => podList(reviewerStatus(0)), log);
            const result = await runReviewInGroup(deps, run);
            expect(result.stderr).toContain('the reviewer container: running');
            expect(result.stderr).toContain('logs unavailable');
            expect(result.exitCode).toBeNull();
        }
    });

    it('a list that fails or 5xxs is "state unknown" and no log can be addressed', async () => {
        const lists: Array<() => K8sResponse | Promise<K8sResponse>> = [
            () => Promise.reject(new Error('refused')),
            () => ({ status: 503, body: '' }),
        ];
        for (const list of lists) {
            const { deps, seen } = harness(list, () => ({ status: 200, body: `${LOG_LINE}\n` }));
            const result = await runReviewInGroup(deps, run);
            expect(result.stderr).toContain('state unknown:');
            expect(result.stderr).toContain('logs unavailable');
            expect(result.exitCode).toBeNull();
            expect(seen.some((s) => s.path.includes('/log'))).toBe(false);
        }
    });

    it('a pod with no reviewer entry is "state unknown", and the current log is read', async () => {
        const { deps, seen } = harness(
            () => podList(undefined),
            () => ({ status: 200, body: `${LOG_LINE}\n` })
        );
        const result = await runReviewInGroup(deps, run);
        expect(result.stderr).toContain('state unknown:');
        expect(result.stderr).toContain(LOG_LINE);
        expect(logPath(seen)).not.toContain('previous');
    });

    it('both reads share one 5 s signal', async () => {
        const { deps, seen } = harness(
            () => podList(reviewerStatus(0)),
            () => ({ status: 200, body: 'x' })
        );
        await runReviewInGroup(deps, run);
        expect(seen).toHaveLength(2);
        expect(seen[0]!.signal).toBeDefined();
        expect(seen[1]!.signal).toBe(seen[0]!.signal);
    });

    it('an answered review is not read', async () => {
        steps.run.mockResolvedValue({ ...lost, exitCode: 1 });
        const { deps, seen } = harness(
            () => podList(reviewerStatus(0)),
            () => ({ status: 200, body: 'x' })
        );
        expect((await runReviewInGroup(deps, run)).stderr).toBe('its loop is not running');
        expect(seen).toEqual([]);
    });

    it('an aborted review is not read', async () => {
        const controller = new AbortController();
        steps.run.mockImplementation(async () => {
            controller.abort();
            return lost;
        });
        const { deps, seen } = harness(
            () => podList(reviewerStatus(0)),
            () => ({ status: 200, body: 'x' })
        );
        expect((await runReviewInGroup(deps, run, controller.signal)).stderr).toBe('its loop is not running');
        expect(seen).toEqual([]);
    });
});
