import { describe, expect, it } from 'vitest';
import { createBoard } from '../src/board/board.js';
import { BoardUncodedAnswerError, withBoardRetry } from '../src/board/board-retry.js';
import { boardJob } from './fixtures/board-job.js';

/**
 * What a mixed-version roll or a load balancer puts on the wire that is NOT the board's own answer: a Fastify
 * route miss on a replica without the route (no `code`), the board's own uncoded not-found handler, a proxy's
 * HTML page. None is a verdict (AGENTS.md: an unconfirmed read never licenses a delete or a negative verdict).
 */
const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const routeMiss = () => json(404, { message: 'Route POST:/api/jobs/x not found', error: 'Not Found', statusCode: 404 });
const boardMiss = () => json(404, { error: 'Not found' });
const html = (status: number) => () =>
    new Response(`<html><body><h1>${status}</h1></body></html>`, { status, headers: { 'content-type': 'text/html' } });

const FAULTS: [string, () => Response][] = [
    ['a Fastify route miss', routeMiss],
    ['the board uncoded not-found', boardMiss],
    ['an HTML 404', html(404)],
    ['an HTML 409', () => html(409)()],
];

const boardAnswering = (respond: () => Response) =>
    createBoard({
        url: 'http://board',
        leaseSeconds: 300,
        fetch: (async () => respond()) as unknown as typeof globalThis.fetch,
    });

const job = boardJob();
const result = { status: 'succeeded', exitCode: 0, output: '' } as never;
const ref = { jobId: 'j', claimSeq: 1, session: 's' };
const streamRef = { executor: 'claude-code', session: 's', stream: 'transcript' } as never;
const manifest = { state: 'complete', bytes: 0, chunks: [] } as never;
const gateRun = { runClaimSeq: 1 } as never;
const checkpoint = { runClaimSeq: 1, phase: 'gates', tree: null, result: {} } as never;
const prWrite = { operationId: 'o', operation: 'open', repo: 'a/b', prNumber: 1, prUrl: 'u', branch: 'b' } as never;

/** Every call that reads a 404 or 409 as the board's verdict: it must reject, never return the verdict. */
const VERDICT_CALLS: [string, (b: ReturnType<typeof boardAnswering>) => Promise<unknown>][] = [
    ['heartbeat', (b) => b.heartbeat(job)],
    ['stageConclusion', (b) => b.stageConclusion(job, result)],
    ['complete', (b) => b.complete(job, result)],
    ['interrupt', (b) => b.interrupt(job, { reason: 'drain' } as never)],
    ['progress', (b) => b.progress(job, 'out')],
    ['gates', (b) => b.gates(job, [])],
    ['session', (b) => b.session(job, 's')],
    ['suspend', (b) => b.suspend(job)],
    ['requireConnection', (b) => b.requireConnection(job, 'jira')],
    ['ackReclaim', (b) => b.ackReclaim('r', 't')],
    ['renewReclaim', (b) => b.renewReclaim('r', 't')],
    ['checkpoint', (b) => b.checkpoint(job)],
    ['transcripts', (b) => b.transcripts(job)],
    ['checkpointChunk (null is "absent")', (b) => b.checkpointChunk(job, 0)],
    ['transcriptChunk (null is "absent")', (b) => b.transcriptChunk(job, ref, 0)],
    ['attachmentContent (null is "absent")', (b) => b.attachmentContent(job, 'a')],
    ['skillContent (null is "absent")', (b) => b.skillContent(job, 'v')],
];

describe.each(FAULTS)('%s answering a board call', (_name, respond) => {
    const board = boardAnswering(respond);

    it.each(VERDICT_CALLS)('%s throws instead of reading a verdict', async (_call, call) => {
        await expect(call(board)).rejects.toBeInstanceOf(BoardUncodedAnswerError);
    });

    it('the leased record writes say rejected, never a lost lease', async () => {
        expect(await board.gateRun(job, gateRun)).toBe('rejected');
        expect(await board.phaseCheckpoint(job, checkpoint)).toBe('rejected');
        expect(await board.prOperation(job, prWrite)).toBe('rejected');
    });

    it('the artifact calls throw instead of reading a permanent refusal', async () => {
        await expect(board.putArtifactChunk(job, streamRef, 0, new Uint8Array())).rejects.toBeInstanceOf(
            BoardUncodedAnswerError
        );
        await expect(board.finalizeArtifact(job, streamRef, manifest)).rejects.toBeInstanceOf(BoardUncodedAnswerError);
    });

    it('the github credential ask is unanswered, never refused', async () => {
        const grant = await board.githubGrant(job, AbortSignal.timeout(300));
        expect(grant.kind).toBe('unanswered');
    });
});

describe('the board answering with its own code', () => {
    it('a coded NOT_FOUND is still removed, a coded LEASE_LOST still lost', async () => {
        const removed = boardAnswering(() => json(404, { error: 'No such job', code: 'NOT_FOUND' }));
        const lost = boardAnswering(() => json(409, { error: 'Lease lost', code: 'LEASE_LOST' }));
        expect(await removed.heartbeat(job)).toBe('removed');
        expect(await lost.heartbeat(job)).toBe('lost');
        expect(await removed.stageConclusion(job, result)).toBe('removed');
        expect(await removed.interrupt(job, { reason: 'drain' } as never)).toBe('lost');
        expect(await removed.requireConnection(job, 'jira')).toBe('removed');
        expect(await removed.checkpointChunk(job, 0)).toBeNull();
        expect(await removed.gateRun(job, gateRun)).toBe('lost');
    });

    it('a coded refusal is still the github ask refused; 408 and 425 are never', async () => {
        const refused = boardAnswering(() => json(403, { error: 'no', code: 'CONNECTION_NOT_AUTHORIZED' }));
        const noApp = boardAnswering(() => json(409, { error: 'no app', code: 'GITHUB_UNAVAILABLE' }));
        expect((await refused.githubGrant(job, AbortSignal.timeout(300))).kind).toBe('refused');
        expect((await noApp.githubGrant(job, AbortSignal.timeout(300))).kind).toBe('refused');
        for (const status of [408, 425]) {
            const board = boardAnswering(() => json(status, { error: 'later', code: 'X' }));
            expect((await board.githubGrant(job, AbortSignal.timeout(300))).kind).toBe('unanswered');
        }
    });
});

describe('a verdict call behind the retry', () => {
    it('is retried over an uncoded 404 and then reads the board real answer', async () => {
        const answers = [routeMiss, () => json(200, { ok: true })];
        let calls = 0;
        const board = boardAnswering(() => answers[Math.min(calls++, answers.length - 1)]?.() as Response);
        const logs: string[] = [];
        const io = { log: (m: string) => logs.push(m), sleep: async () => {} };
        const out = await withBoardRetry(io, 'heartbeat', () => board.heartbeat(job));
        expect(out).toMatchObject({ result: 'held' });
        expect(calls).toBe(2);
    });

    it('a coded 400 is still not retried', async () => {
        let calls = 0;
        const board = boardAnswering(() => {
            calls++;
            return json(400, { error: 'bad', code: 'BAD_BODY' });
        });
        const io = { log: () => {}, sleep: async () => {} };
        await expect(withBoardRetry(io, 'heartbeat', () => board.heartbeat(job))).rejects.toThrow(/400/);
        expect(calls).toBe(1);
    });
});
