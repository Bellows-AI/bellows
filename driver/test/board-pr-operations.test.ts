import { describe, expect, it } from 'vitest';
import { createBoard } from '../src/board/board.js';
import { boardJob } from './fixtures/board-job.js';

/**
 * The PR-operation record's board call (issue #983): one lease-fenced write per managed publish
 * operation. It answers whether the board took the row and never throws, so a publish that already
 * landed its PR is never failed by the bookkeeping.
 */
const write = {
    operationId: '88888888-8888-4888-8888-888888888888',
    operation: 'created' as const,
    repo: 'Bellows-AI/factory',
    prNumber: 42,
    prUrl: 'https://github.com/Bellows-AI/factory/pull/42',
    branch: 'fix/10',
};

function recorder(respond: () => Response) {
    const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
        calls.push({
            url,
            headers: init.headers as Record<string, string>,
            body: init.body ? JSON.parse(init.body as string) : undefined,
        });
        return respond();
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetch };
}

const boardOn = (fetch: typeof globalThis.fetch, token?: string) =>
    createBoard({ url: 'http://board', leaseSeconds: 300, token, fetch });

describe('the PR operation record (issue #983)', () => {
    const job = boardJob();

    it('writes the operation under the lease token', async () => {
        const { calls, fetch } = recorder(() => Response.json({ id: 'job-1', operationId: write.operationId }));
        expect(await boardOn(fetch, 'fwt_abc').prOperation(job, write)).toBe('ok');
        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1/pr-operation');
        expect(calls[0]!.headers.authorization).toBe('Bearer fwt_abc');
        expect(calls[0]!.body).toEqual({ leaseToken: job.leaseToken, ...write });
    });

    it.each<[string, () => Response, string]>([
        ['a lost lease', () => Response.json({ code: 'LEASE_LOST' }, { status: 409 }), 'lost'],
        ['a removed thread', () => Response.json({ code: 'NOT_FOUND' }, { status: 404 }), 'lost'],
        ['a 400', () => Response.json({ code: 'BAD_BODY' }, { status: 400 }), 'rejected'],
        ['a 500', () => Response.json({ error: 'down' }, { status: 500 }), 'rejected'],
    ])('answers a write refused with %s as %s', async (_what, respond, answer) => {
        const { fetch } = recorder(respond);
        expect(await boardOn(fetch).prOperation(job, write)).toBe(answer);
    });

    it('never throws on a rejected fetch: the row did not land', async () => {
        const failing = (async () => {
            throw new Error('connection reset');
        }) as unknown as typeof globalThis.fetch;
        expect(await boardOn(failing).prOperation(job, write)).toBe('rejected');
    });

    it('a board that takes the request and never answers is not recorded once the bound expires', async () => {
        // The fetch ignores its signal on purpose: the bound must hold even over a transport that
        // never settles, or the publish that already landed its PR waits on the bookkeeping.
        const stalled = (() => new Promise<Response>(() => undefined)) as unknown as typeof globalThis.fetch;
        expect(await boardOn(stalled).prOperation(job, write, AbortSignal.timeout(20))).toBe('rejected');
    });
});
