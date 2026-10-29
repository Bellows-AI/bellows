import { describe, expect, it } from 'vitest';
import { jobsPath, runnerJobName } from '../../src/k8s/k8s-podspec.js';
import type { K8sMethod } from '../../src/k8s/k8s-transport.js';
import { claimPathFor, namespace, routed, runner } from '../fixtures/k8s-suite.js';
import { drive, job, stubBoard } from '../fixtures/loop-stubs.js';

/*
 * BEL-160: a takeover sweep that meets a leftover pod stuck terminating (its node gone) is handed
 * back to the board as a blocked interruption, never left to the lease — the real loop over the
 * real kubernetes runner, only the cluster's API faked.
 */
describe('a takeover sweep blocked by a leftover pod stuck terminating', () => {
    const claimed = { ...job(1), claimSeq: 2, repo: 'Bellows-AI/factory' };
    const OLD = '55555555-5555-4555-8555-555555555555';
    const podOf = (extra: Record<string, unknown>) => ({
        metadata: {
            name: 'stuck-pod',
            uid: 'uid-stuck-pod',
            labels: {
                'factory.job': claimed.id,
                'factory.lease': OLD,
                'job-name': runnerJobName({ ...claimed, leaseToken: OLD }),
            },
            ...extra,
        },
        spec: { nodeName: 'node-a' },
    });
    const isPodList = (method: K8sMethod, path: string) =>
        method === 'GET' &&
        path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) &&
        decodeURIComponent(path).includes('lease!=');

    async function sweepAgainst(pod: unknown) {
        const api = routed((method, path) => {
            if (isPodList(method, path)) return { status: 200, body: JSON.stringify({ items: [pod] }) };
            if (method === 'DELETE' && path.includes('/secrets/')) return { status: 404, body: '{"kind":"Status"}' };
        });
        const stub = stubBoard([claimed]);
        const lines: string[] = [];
        await drive({ ...stub, runner: runner(api.request), log: (line) => lines.push(line) });
        return { board: stub.board, calls: api.calls, lines };
    }

    it('hands a claim whose sweep meets a pod stuck terminating on its node back as a blocked interruption, never to the lease', async () => {
        const { board, calls, lines } = await sweepAgainst(podOf({ deletionTimestamp: '2026-10-29T10:00:00Z' }));

        expect(board.interrupted).toHaveLength(1);
        expect(board.interrupted[0]).toMatchObject({ id: claimed.id, release: true, blocked: true, refused: true });
        expect(board.interrupted[0]!.reason).toMatch(/still terminating/);
        expect(board.interrupted[0]!.reason).toContain('stuck-pod');
        expect(board.interrupted[0]!.reason).toContain('node-a');
        expect(board.completed).toEqual([]);
        expect(lines.some((line) => line.includes('leaving it to the lease'))).toBe(false);
        expect(calls.some((c) => c.method === 'POST' && c.path === jobsPath(namespace))).toBe(false);
        expect(calls.some((c) => c.method === 'DELETE' && c.path.startsWith(claimPathFor(claimed.id)))).toBe(true);
    });

    it('still leaves a sweep blocked by a leftover WITHOUT a deletionTimestamp to the lease', async () => {
        const { board, lines } = await sweepAgainst(podOf({}));

        expect(board.interrupted).toEqual([]);
        expect(lines.some((line) => line.includes('leaving it to the lease'))).toBe(true);
    });
});
