import { describe, expect, it } from 'vitest';
import type { K8sResponse } from '../../src/k8s/k8s-transport.js';
import { fakeRequest, fakeSteps, runner } from '../fixtures/k8s-suite.js';
import { drive, job, stubBoard } from '../fixtures/loop-stubs.js';
import { githubRef } from '../fixtures/repo-ref.js';

// The real loop over the real kubernetes runner, only the API server faked: a runner Job the API
// server refuses with a 422 `Status` (an admission policy's denial) is refused again on every claim
// with the same spec, so the task fails as config once; an unconfirmed answer stays left to the lease.
describe('a runner Job create the API server answers, through the loop', () => {
    const refused422: K8sResponse = {
        status: 422,
        body: JSON.stringify({
            kind: 'Status',
            apiVersion: 'v1',
            status: 'Failure',
            reason: 'Invalid',
            code: 422,
            message: 'jobs.batch "factory-run-x" is forbidden: a runner may not add capabilities',
        }),
    };

    const driveWith = async (create: K8sResponse) => {
        const board = stubBoard([{ ...job(1), repo: githubRef('example-org/example-repo') }]);
        const claim = board.board.claim.bind(board.board);
        let claims = 0;
        board.board.claim = async (...args: Parameters<typeof claim>) => {
            const claimed = await claim(...args);
            if (claimed) claims += 1;
            return claimed;
        };
        await drive(
            { ...board, runner: runner(fakeRequest({ create }).request, {}, undefined, fakeSteps().sink) },
            { EXECUTOR: 'kubernetes' }
        );
        return { board: board.board, claims };
    };

    it('a runner Job refused with 422 fails the task as config, once, never left to the lease', async () => {
        const { board, claims } = await driveWith(refused422);
        expect(board.completed).toHaveLength(1);
        expect(board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'config' });
        expect(board.completed[0]?.output).toMatch(
            /^The runner could not start: creating the runner job was refused \(422 Invalid\)/
        );
        expect(board.interrupted).toEqual([]);
        expect(claims).toBe(1);
    });

    it('a runner Job create answered 503 is left to the lease', async () => {
        const { board } = await driveWith({ status: 503, body: 'service unavailable' });
        expect(board.completed).toEqual([]);
        expect(board.interrupted).toEqual([]);
    });
});
