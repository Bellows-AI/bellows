import { describe, expect, it } from 'vitest';
import { type BoardJob, createBoard } from '../src/board/board.js';
import { claimOf, parseClaim } from '../src/board/board-claim.js';
import { boardJob } from './fixtures/board-job.js';

/**
 * The gate-run record's two board calls: the write is lease-fenced and answers whether
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
    createBoard({ url: 'http://board', leaseSeconds: 300, ...(token ? { credential: () => token } : {}), fetch });

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

    it('writes a row under the lease token and reads the thread’s rows back', async () => {
        const written = recorder(() => Response.json({ id: 'job-1', executionId: write.executionId }));
        expect(await boardOn(written.fetch, 'fwt_abc').gateRun(job, write)).toBe('ok');
        expect(written.calls[0]!.url).toBe('http://board/api/jobs/job-1/gate-run');
        expect(written.calls[0]!.headers.authorization).toBe('Bearer fwt_abc');
        expect(written.calls[0]!.body).toEqual({ leaseToken: job.leaseToken, ...write });

        const read = recorder(() => Response.json({ runs: [row] }));
        expect(await boardOn(read.fetch).gateRuns(job)).toEqual([row]);
        expect(read.calls[0]!.url).toBe('http://board/api/jobs/job-1/gate-runs');
    });

    it('reads the thread’s record under the lease alone', async () => {
        const read = recorder(() => Response.json({ runs: [row] }));
        await boardOn(read.fetch).gateRuns(job);
        expect(read.calls[0]!.body).toEqual({ leaseToken: job.leaseToken });
    });

    it('reads an empty answer as no rows, not as an unreadable one', async () => {
        const { fetch } = recorder(() => Response.json({ runs: [] }));
        expect(await boardOn(fetch).gateRuns(job)).toEqual([]);
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
        expect(await boardOn(fetch).gateRuns(job)).toBeNull();
    });

    it('reads a rejected fetch and an aborted signal as unreadable', async () => {
        const failing = (async () => {
            throw new Error('connection reset');
        }) as unknown as typeof globalThis.fetch;
        expect(await boardOn(failing).gateRuns(job)).toBeNull();
        const { fetch } = recorder(() => Response.json({ runs: [row] }));
        const slow = ((url: string, init: RequestInit) =>
            init.signal?.aborted ? Promise.reject(init.signal.reason) : fetch(url, init)) as unknown as typeof fetch;
        expect(await boardOn(slow).gateRuns(job, AbortSignal.abort())).toBeNull();
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

describe('the finish passes', () => {
    const job = boardJob();
    const pass = {
        passId: '88888888-8888-4888-8888-888888888888',
        runClaimSeq: 2,
        verdict: 'failed' as const,
        gate: 'test',
    };

    it('records a pass under the lease token and reads the failed rounds back', async () => {
        const written = recorder(() => Response.json({ id: 'job-1', passId: pass.passId }));
        expect(await boardOn(written.fetch, 'fwt_abc').finishPass(job, pass)).toBe('ok');
        expect(written.calls[0]!.url).toBe('http://board/api/jobs/job-1/finish-passes');
        expect(written.calls[0]!.headers.authorization).toBe('Bearer fwt_abc');
        expect(written.calls[0]!.body).toEqual({ leaseToken: job.leaseToken, ...pass });

        const read = recorder(() => Response.json({ failedRounds: 2, pass: null }));
        expect(await boardOn(read.fetch).finishRounds(job, pass.passId)).toEqual({ failedRounds: 2, pass: null });
        expect(read.calls[0]!.url).toBe('http://board/api/jobs/job-1/finish-passes/read');
        expect(read.calls[0]!.body).toEqual({ leaseToken: job.leaseToken, passId: pass.passId });
    });

    it('reads zero failed rounds as zero, not as unreadable', async () => {
        const { fetch } = recorder(() => Response.json({ failedRounds: 0, pass: null }));
        expect(await boardOn(fetch).finishRounds(job, pass.passId)).toEqual({ failedRounds: 0, pass: null });
    });

    it.each([[{ verdict: 'failed', round: 1 }], [{ verdict: 'passed' }]])(
        'reads the recorded pass %j of the asked id',
        async (recorded) => {
            const { fetch } = recorder(() => Response.json({ failedRounds: 1, pass: recorded }));
            expect(await boardOn(fetch).finishRounds(job, pass.passId)).toEqual({ failedRounds: 1, pass: recorded });
        }
    );

    it.each<[string, () => Response]>([
        ['a 409', () => Response.json({ code: 'LEASE_LOST' }, { status: 409 })],
        ['a 404', () => Response.json({ code: 'NOT_FOUND' }, { status: 404 })],
        ['a 500', () => Response.json({ error: 'down' }, { status: 500 })],
        ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
        ['no failedRounds field', () => Response.json({})],
        ['a fractional count', () => Response.json({ failedRounds: 1.5 })],
        ['a negative count', () => Response.json({ failedRounds: -1 })],
        ['a string count', () => Response.json({ failedRounds: '2' })],
        ['a null body', () => Response.json(null)],
        ['no pass field', () => Response.json({ failedRounds: 1 })],
        ['a pass of an unknown verdict', () => Response.json({ failedRounds: 1, pass: { verdict: 'maybe' } })],
        ['a failed pass with no round', () => Response.json({ failedRounds: 1, pass: { verdict: 'failed' } })],
        ['a failed pass of round 0', () => Response.json({ failedRounds: 1, pass: { verdict: 'failed', round: 0 } })],
        ['a pass that is a string', () => Response.json({ failedRounds: 1, pass: 'failed' })],
    ])('reads %s as unknown rounds, never as zero or as not recorded', async (_what, respond) => {
        const { fetch } = recorder(respond);
        expect(await boardOn(fetch).finishRounds(job, pass.passId)).toBeNull();
    });

    it('reads a rejected fetch and a timed-out signal as unknown rounds', async () => {
        const failing = (async () => {
            throw new Error('connection reset');
        }) as unknown as typeof globalThis.fetch;
        expect(await boardOn(failing).finishRounds(job, pass.passId)).toBeNull();
        const { fetch } = recorder(() => Response.json({ failedRounds: 1, pass: null }));
        const slow = ((url: string, init: RequestInit) =>
            init.signal?.aborted ? Promise.reject(init.signal.reason) : fetch(url, init)) as unknown as typeof fetch;
        const timedOut = AbortSignal.abort(new DOMException('the read timed out', 'TimeoutError'));
        expect(await boardOn(slow).finishRounds(job, pass.passId, timedOut)).toBeNull();
    });

    it.each<[string, string, () => Response]>([
        ['a lost lease', 'lost', () => Response.json({ code: 'LEASE_LOST' }, { status: 409 })],
        ['a conflicting run claim', 'rejected', () => Response.json({ code: 'GATE_RUN_CONFLICT' }, { status: 409 })],
        ['a removed thread', 'lost', () => Response.json({ code: 'NOT_FOUND' }, { status: 404 })],
        ['a 400', 'rejected', () => Response.json({ code: 'BAD_BODY' }, { status: 400 })],
        ['a 500', 'rejected', () => Response.json({ error: 'down' }, { status: 500 })],
    ])('answers a pass refused with %s as %s', async (_what, answer, respond) => {
        const { fetch } = recorder(respond);
        expect(await boardOn(fetch).finishPass(job, pass)).toBe(answer);
    });
});

describe('the round cap on the claim', () => {
    const { finishRounds: _none, ...wire } = boardJob();

    it.each([0, 3, 10])('carries a cap of %i as is', (cap) => {
        expect(claimOf({ ...wire, finishRounds: cap }).finishRounds).toBe(cap);
    });

    it.each<[string, unknown]>([
        ['missing', undefined],
        ['null', null],
        ['textual', '3'],
        ['fractional', 1.5],
        ['negative', -1],
    ])('leaves a %s cap unknown, never 0, and keeps the claim', (_what, value) => {
        const parsed = parseClaim({ ...wire, finishRounds: value });
        expect('claim' in parsed).toBe(true);
        const claim = (parsed as { claim: BoardJob }).claim;
        expect(claim.finishRounds).toBeUndefined();
        expect('finishRounds' in claim).toBe(false);
    });
});

describe("a gate run's whole output", () => {
    const job = boardJob();
    const executionId = '77777777-7777-4777-8777-777777777777';

    it('reads the stored log by execution id under the lease', async () => {
        const read = recorder(() => Response.json({ text: 'FAIL a.test.ts', truncated: true }));
        expect(await boardOn(read.fetch).gateLog(job, executionId)).toEqual({
            text: 'FAIL a.test.ts',
            truncated: true,
        });
        expect(read.calls[0]!.url).toBe('http://board/api/jobs/job-1/gate-log');
        expect(read.calls[0]!.body).toEqual({ leaseToken: job.leaseToken, executionId });
    });

    it('answers null for a log the board does not hold, and throws for any answer it cannot read', async () => {
        const missing = recorder(() => Response.json({ code: 'NOT_FOUND' }, { status: 404 }));
        expect(await boardOn(missing.fetch).gateLog(job, executionId)).toBeNull();
        const down = recorder(() => Response.json({ error: 'down' }, { status: 500 }));
        await expect(boardOn(down.fetch).gateLog(job, executionId)).rejects.toThrow();
        const garbled = recorder(() => Response.json({ nothing: true }));
        await expect(boardOn(garbled.fetch).gateLog(job, executionId)).rejects.toThrow('unreadable');
    });

    it('carries the execution id of a stored report through the claim', () => {
        const { finishRounds: _none, ...wire } = boardJob();
        const report = { name: 'test', status: 'failed', exitCode: 1, output: 'x', executionId };
        const parsed = parseClaim({ ...wire, lastGateReports: [report] }) as { claim: BoardJob };
        expect(parsed.claim.lastGateReports?.[0]?.executionId).toBe(executionId);
        expect('claim' in parseClaim({ ...wire, lastGateReports: [{ ...report, executionId: 5 }] })).toBe(false);
    });
});
