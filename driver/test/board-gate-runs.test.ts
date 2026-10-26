import { describe, expect, it } from 'vitest';
import { createBoard } from '../src/board/board.js';
import { boardJob } from './fixtures/board-job.js';

/**
 * The gate-run record's two board calls (issue #983): the write is lease-fenced and answers whether
 * the row landed; the read answers the rows or null — an unconfirmed read is never an empty one.
 */
interface Call {
    url: string;
    headers: Record<string, string>;
    body: unknown;
}

function recorder(respond: () => Response) {
    const calls: Call[] = [];
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

const write = {
    runClaimSeq: 2,
    executionId: '77777777-7777-4777-8777-777777777777',
    gate: 'test',
    identity: 'a'.repeat(64),
    filtered: false,
    source: 'adhoc' as const,
    outcome: 'running' as const,
    exitCode: null,
    treeBefore: 'h:1',
    treeAfter: null,
    mutatedSince: null,
    startedAt: '2026-10-26T10:00:00.000Z',
    finishedAt: null,
};

const row = { ...write, outcome: 'passed', exitCode: 0, treeAfter: 'h:1', mutatedSince: false, claimSeq: 2 };

describe('the gate runs (issue #983)', () => {
    const job = boardJob();

    it('writes a row under the lease token and reads the run’s rows back', async () => {
        const written = recorder(() => Response.json({ id: 'job-1', executionId: write.executionId }));
        expect(await boardOn(written.fetch, 'fwt_abc').gateRun(job, write)).toBe('ok');
        expect(written.calls[0]!.url).toBe('http://board/api/jobs/job-1/gate-run');
        expect(written.calls[0]!.headers.authorization).toBe('Bearer fwt_abc');
        expect(written.calls[0]!.body).toEqual({ leaseToken: job.leaseToken, ...write });

        const read = recorder(() => Response.json({ runs: [row] }));
        expect(await boardOn(read.fetch).gateRuns(job, 2)).toEqual([row]);
        expect(read.calls[0]!.url).toBe('http://board/api/jobs/job-1/gate-runs');
        expect(read.calls[0]!.body).toEqual({ leaseToken: job.leaseToken, runClaimSeq: 2 });
    });

    it('reads an empty answer as no rows, not as an unreadable one', async () => {
        const { fetch } = recorder(() => Response.json({ runs: [] }));
        expect(await boardOn(fetch).gateRuns(job, 2)).toEqual([]);
    });

    it.each<[string, () => Response]>([
        ['a 409', () => Response.json({ code: 'LEASE_LOST' }, { status: 409 })],
        ['a 404', () => Response.json({ code: 'NOT_FOUND' }, { status: 404 })],
        ['a 500', () => Response.json({ error: 'down' }, { status: 500 })],
        ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
        ['no runs field', () => Response.json({})],
        ['a row that is not an object', () => Response.json({ runs: [null] })],
        ['an unknown outcome', () => Response.json({ runs: [{ ...row, outcome: 'maybe' }] })],
        ['an unknown source', () => Response.json({ runs: [{ ...row, source: 'cron' }] })],
        ['a fractional exit code', () => Response.json({ runs: [{ ...row, exitCode: 1.5 }] })],
        ['a numeric tree', () => Response.json({ runs: [{ ...row, treeAfter: 7 }] })],
        ['a string mutation flag', () => Response.json({ runs: [{ ...row, mutatedSince: 'no' }] })],
        ['a missing identity', () => Response.json({ runs: [{ ...row, identity: undefined }] })],
        ['a non-boolean filtered flag', () => Response.json({ runs: [{ ...row, filtered: 0 }] })],
        ['a fractional run claim', () => Response.json({ runs: [{ ...row, runClaimSeq: 1.5 }] })],
        ['one good row and one bad', () => Response.json({ runs: [row, { ...row, gate: 3 }] })],
    ])('reads %s as unreadable, never as empty', async (_what, respond) => {
        const { fetch } = recorder(respond);
        expect(await boardOn(fetch).gateRuns(job, 2)).toBeNull();
    });

    it('reads a rejected fetch and an aborted signal as unreadable', async () => {
        const failing = (async () => {
            throw new Error('connection reset');
        }) as unknown as typeof globalThis.fetch;
        expect(await boardOn(failing).gateRuns(job, 2)).toBeNull();
        const { fetch } = recorder(() => Response.json({ runs: [row] }));
        const slow = ((url: string, init: RequestInit) =>
            init.signal?.aborted ? Promise.reject(init.signal.reason) : fetch(url, init)) as unknown as typeof fetch;
        expect(await boardOn(slow).gateRuns(job, 2, AbortSignal.abort())).toBeNull();
    });

    it.each<[string, () => Response, string]>([
        ['a lost lease', () => Response.json({ code: 'LEASE_LOST' }, { status: 409 }), 'lost'],
        ['a conflicting run claim', () => Response.json({ code: 'GATE_RUN_CONFLICT' }, { status: 409 }), 'rejected'],
        ['a removed thread', () => Response.json({ code: 'NOT_FOUND' }, { status: 404 }), 'lost'],
        ['a 400', () => Response.json({ code: 'BAD_BODY' }, { status: 400 }), 'rejected'],
        ['a 500', () => Response.json({ error: 'down' }, { status: 500 }), 'rejected'],
    ])('answers a write refused with %s as %s', async (_what, respond, answer) => {
        const { fetch } = recorder(respond);
        expect(await boardOn(fetch).gateRun(job, write)).toBe(answer);
    });

    it('never throws on a rejected fetch: the row did not land', async () => {
        const failing = (async () => {
            throw new Error('connection reset');
        }) as unknown as typeof globalThis.fetch;
        expect(await boardOn(failing).gateRun(job, write)).toBe('rejected');
    });
});
