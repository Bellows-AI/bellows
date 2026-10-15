import { describe, expect, it } from 'vitest';
import { createBoard } from '../src/board.js';
import { boardJob } from './fixtures/board-job.js';

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

/** The board client under test, on the shared URL and lease; `token` only where the test needs one. */
const boardOn = (fetch: typeof globalThis.fetch, token?: string) =>
    createBoard({ url: 'http://board', leaseSeconds: 300, token, fetch });

const claimed = (extra: Record<string, unknown> = {}) =>
    new Response(
        JSON.stringify({
            id: 'job-1',
            command: 'echo hi',
            attempts: 1,
            claimSeq: 1,
            leaseToken: 'token-1',
            leaseExpiresAt: '2026-08-21T12:05:00.000Z',
            ...extra,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
    );

describe('the worker token', () => {
    it('is sent as a bearer header when the board requires one', async () => {
        const { calls, fetch } = recorder(() => claimed());
        const board = boardOn(fetch, 'fwt_abc');

        await board.claim('driver-1');

        expect(calls[0]!.headers.authorization).toBe('Bearer fwt_abc');
    });

    it('is OMITTED entirely against an open board, not sent empty', async () => {
        // An empty Bearer header is a credential that failed; no header at all is one that was
        // never offered. Only the second keeps AUTH_MODE=none working unchanged.
        const { calls, fetch } = recorder(() => claimed());
        const board = boardOn(fetch);

        await board.claim('driver-1');

        expect(calls[0]!.headers).not.toHaveProperty('authorization');
    });

    it('travels on every write, not only the claim', async () => {
        const { calls, fetch } = recorder(() => new Response('{}', { status: 200 }));
        const board = boardOn(fetch, 'fwt_abc');
        const job = boardJob();

        await board.heartbeat(job);
        await board.session(job, 'session-1');
        await board.progress(job, 'a tail of the output');
        await board.suspend(job);
        await board.complete(job, { status: 'succeeded', exitCode: 0, output: '' });

        const EXPECTED_WRITE_CALLS = 5;
        expect(calls).toHaveLength(EXPECTED_WRITE_CALLS);
        for (const call of calls) expect(call.headers.authorization).toBe('Bearer fwt_abc');
    });

    // The one write whose purpose is the dashboard: the tail travels on its own route so a reader
    // can watch the work while it happens.
    it('streams the output tail to the job it belongs to', async () => {
        const { calls, fetch } = recorder(() => new Response('{}', { status: 200 }));
        const board = boardOn(fetch);
        const job = boardJob();

        await board.progress(job, 'partial output');

        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1/output');
        expect(calls[0]!.body).toEqual({ leaseToken: 'token-1', output: 'partial output' });
    });

    // The run artifacts (issue #325): the close-time upload of the full log and the transcript,
    // one kind per POST, lease token beside the payload like every worker write.
    it('uploads a run artifact to its route with kind, attempt and the truncation flag', async () => {
        const { calls, fetch } = recorder(() => new Response('{}', { status: 200 }));
        const board = boardOn(fetch);
        const job = boardJob({ attempts: 2, claimSeq: 2 });

        const state = await board.artifact(job, {
            kind: 'log',
            attempt: 2,
            content: 'the whole log\n',
            truncated: true,
        });

        expect(state).toBe('held');
        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1/artifact');
        expect(calls[0]!.body).toEqual({
            leaseToken: 'token-1',
            kind: 'log',
            attempt: 2,
            content: 'the whole log\n',
            truncated: true,
        });
    });

    it('reads a 409 from the artifact upload as lost, not a kill order', async () => {
        const { fetch } = recorder(() => new Response('{}', { status: 409 }));
        const board = boardOn(fetch);
        const job = boardJob();

        expect(await board.artifact(job, { kind: 'transcript', attempt: 1, content: '[]', truncated: false })).toBe(
            'lost'
        );
    });

    /**
     * The runtime sample travels inside the progress body, verbatim. A vitals-only sample
     * carries no `services` key at all — the byte-identical pin (issue #60): a job whose
     * attempt declared no services must put exactly what it always put on the wire.
     */
    it('carries the runtime sample verbatim, with services only when there are any', async () => {
        const { calls, fetch } = recorder(() => new Response('{}', { status: 200 }));
        const board = boardOn(fetch);
        const job = boardJob();

        await board.progress(job, 'partial output', {
            cpuPercent: 93,
            memUsedMb: 544,
            memPercent: 7,
            activity: '→ Read x',
            sampledAt: '2026-09-14T10:00:00.000Z',
        });

        expect(calls[0]!.body).toEqual({
            leaseToken: 'token-1',
            output: 'partial output',
            runtime: {
                cpuPercent: 93,
                memUsedMb: 544,
                memPercent: 7,
                activity: '→ Read x',
                sampledAt: '2026-09-14T10:00:00.000Z',
            },
        });
        const firstRuntime = (calls[0]!.body as { runtime: Record<string, unknown> }).runtime;
        expect('services' in firstRuntime).toBe(false);

        await board.progress(job, 'more', {
            cpuPercent: null,
            memUsedMb: null,
            memPercent: null,
            activity: null,
            sampledAt: '2026-09-14T10:00:01.000Z',
            services: [{ name: 'db', image: 'postgres:16', state: 'running' }],
        });
        const secondRuntime = (calls[1]!.body as { runtime: Record<string, unknown> }).runtime;
        expect(secondRuntime.services).toEqual([{ name: 'db', image: 'postgres:16', state: 'running' }]);
    });
});

/** A claim field the client must leave off the job entirely, not set to `undefined`. */
const ABSENT = Symbol('absent');
const PLANS = [{ helperId: 'noop', phase: 'pre', input: { a: 1 }, githubWriting: false }];

describe('the claimed job', () => {
    it.each<[string, Record<string, unknown>, string, unknown]>([
        ['carries a known executor type', { executorType: 'opencode' }, 'executorType', 'opencode'],
        ['refuses to invent an executor type for an unknown value', { executorType: 'other' }, 'executorType', null],
        ['refuses to invent an executor type for a missing value', {}, 'executorType', null],
        // Issue 440.
        [
            'carries the board’s executor refusal',
            { executorRefusal: 'The executor "main" is suspended.' },
            'executorRefusal',
            'The executor "main" is suspended.',
        ],
        ['reads a missing executor refusal as null', {}, 'executorRefusal', null],
        // Issue 545.
        [
            'carries the board’s skill refusal',
            { skillRefusal: '[skills unavailable] skill "jira" needs a connection' },
            'skillRefusal',
            '[skills unavailable] skill "jira" needs a connection',
        ],
        ['reads a missing skill refusal as null', {}, 'skillRefusal', null],
        ['carries the account that queued it', { userId: 'user-7' }, 'userId', 'user-7'],
        // Defensive for the same reason resumeSessionId is: a board that predates the field simply
        // omits it, and `undefined` would flow into a docker argument as the string "undefined".
        ['reads a missing userId as null rather than undefined', {}, 'userId', null],
        ['reads a missing followUp flag as false rather than undefined', {}, 'followUp', false],
        [
            'carries the follow-up flag when the board sets it',
            { followUp: true, resumeSessionId: 'session-1' },
            'followUp',
            true,
        ],
        [
            'carries the resumed session beside the follow-up flag',
            { followUp: true, resumeSessionId: 'session-1' },
            'resumeSessionId',
            'session-1',
        ],
        [
            "passes the thread root's command through as the board sent it",
            { rootCommand: '/fix 122' },
            'rootCommand',
            '/fix 122',
        ],
        // The board always sends it; nothing papers over a payload that lacks it.
        ["reads a missing thread root's command with no fallback", {}, 'rootCommand', undefined],
        ['carries the environment the board resolved', { env: { CORE: 'value' } }, 'env', { CORE: 'value' }],
        // A board that predates the field omits it; `{}` keeps the runner spawn honest.
        ['reads a missing environment as empty', {}, 'env', {}],
        // Issue #207: declared block-helper plans, read the same way every field added after launch
        // is — a board that predates the field, or a job with none, simply omits it.
        ['carries the declared block-helper plans', { helperPlans: PLANS }, 'helperPlans', PLANS],
        ['reads missing block-helper plans as absent', {}, 'helperPlans', undefined],
        [
            'drops a malformed (non-array) helperPlans value rather than passing it through',
            { helperPlans: 'not-an-array' },
            'helperPlans',
            undefined,
        ],
        // Issue #444: which tree the claim's gates were read from. Only the two known values pass;
        // anything else reads as absent, which the loop treats as "no stale-source refusal".
        ['carries the worktree gates source', { gatesSource: 'worktree' }, 'gatesSource', 'worktree'],
        ['carries the clone gates source', { gatesSource: 'clone' }, 'gatesSource', 'clone'],
        ['drops an unknown gates source', { gatesSource: 'elsewhere' }, 'gatesSource', undefined],
        // Issue #244: the board-owned Factory execution context. Read defensively like every other
        // field added after launch — a board that predates it, or a malformed value, both read as
        // null, which the loop refuses the launch for explicitly (loop-run.test.ts) rather than
        // running the agent with no contract.
        [
            'carries the master prompt the board rendered',
            { masterPrompt: 'Factory execution contract (v1)' },
            'masterPrompt',
            'Factory execution contract (v1)',
        ],
        ['reads a missing masterPrompt as null rather than undefined', {}, 'masterPrompt', null],
        [
            'reads a malformed (non-string) masterPrompt as null rather than passing it through',
            { masterPrompt: 42 },
            'masterPrompt',
            null,
        ],
        // Issue #509: the claim's per-node context, delivered per turn (master-prompt.ts).
        ['carries the turn context', { turnContext: 'Factory turn context' }, 'turnContext', 'Factory turn context'],
        ['drops a missing turn context', { turnContext: undefined }, 'turnContext', ABSENT],
        ['drops an empty turn context', { turnContext: '' }, 'turnContext', ABSENT],
        ['drops a non-string turn context', { turnContext: 42 }, 'turnContext', ABSENT],
        ['drops a null turn context', { turnContext: null }, 'turnContext', ABSENT],
    ])('%s', async (_label, extra, field, expected) => {
        const { fetch } = recorder(() => claimed(extra));
        const job = await boardOn(fetch).claim('driver-1');
        if (expected === ABSENT) expect(job).not.toHaveProperty(field);
        else expect(job?.[field as keyof typeof job]).toEqual(expected);
    });
});

describe('rereading the gates after the startup sync', () => {
    const job = boardJob();

    it('asks the board with the lease token and carries the fresh answer', async () => {
        const { calls, fetch } = recorder(() =>
            Response.json(
                { gates: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] }, gateError: null },
                { status: 200 }
            )
        );
        const board = boardOn(fetch, 'fwt_abc');

        const fresh = await board.rereadGates(job);

        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1/gates-reread');
        expect(calls[0]!.body).toEqual({ leaseToken: 'token-1' });
        expect(calls[0]!.headers.authorization).toBe('Bearer fwt_abc');
        expect(fresh).toEqual({
            gates: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
            gateError: null,
        });
    });

    it('answers null — keep the claim’s decision — when the board refuses', async () => {
        const lost = recorder(() => Response.json({ error: 'Lease lost' }, { status: 409 }));
        expect(await boardOn(lost.fetch).rereadGates(job)).toBeNull();

        const dead = recorder(() => Response.json({ error: 'No such job' }, { status: 404 }));
        expect(await boardOn(dead.fetch).rereadGates(job)).toBeNull();
    });

    it('throws when the board could not answer, so the caller can retry it', async () => {
        const broken = recorder(() => {
            throw new Error('board unreachable');
        });
        await expect(boardOn(broken.fetch).rereadGates(job)).rejects.toThrow('board unreachable');

        const down = recorder(() => new Response('bad gateway', { status: 502 }));
        await expect(boardOn(down.fetch).rereadGates(job)).rejects.toThrow(/answered 502/);
    });
});

describe('asking for a publish-fresh credential', () => {
    const job = boardJob();

    it('asks the board with the lease token and carries the credential', async () => {
        const { calls, fetch } = recorder(() => Response.json({ GITHUB_TOKEN: 'ghs_fresh' }, { status: 200 }));
        const board = boardOn(fetch, 'fwt_abc');

        const token = await board.publishToken(job);

        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1/publish-token');
        expect(calls[0]!.body).toEqual({ leaseToken: 'token-1' });
        expect(calls[0]!.headers.authorization).toBe('Bearer fwt_abc');
        expect(token).toBe('ghs_fresh');
    });

    it('answers null — keep the claim env — when the board holds nothing fresher, refuses, or fails', async () => {
        const nothing = recorder(() => Response.json({ GITHUB_TOKEN: null }, { status: 200 }));
        expect(await boardOn(nothing.fetch).publishToken(job)).toBeNull();

        const lost = recorder(() => Response.json({ error: 'Lease lost' }, { status: 409 }));
        expect(await boardOn(lost.fetch).publishToken(job)).toBeNull();

        const dead = recorder(() => Response.json({ error: 'No such job' }, { status: 404 }));
        expect(await boardOn(dead.fetch).publishToken(job)).toBeNull();

        const broken = recorder(() => {
            throw new Error('board unreachable');
        });
        expect(await boardOn(broken.fetch).publishToken(job)).toBeNull();
    });
});

describe('asking the board for the orphan reaper lease lookups', () => {
    // Issue #301: one batched worker route, so a reaper sweep is one request per 100 job ids,
    // not one per object. Null — a refused, lost, or failed answer — means "board cannot
    // answer", and the reaper reaps NOTHING on it.
    const ID_A = '11111111-1111-4111-8111-111111111111';
    const ID_B = '44444444-4444-4444-8444-444444444444';

    it('posts the ids to the leases route and carries the answered rows', async () => {
        const jobs = [
            { id: ID_A, status: 'dead', leaseToken: null },
            { id: ID_B, status: 'running', leaseToken: '22222222-2222-4222-8222-222222222222' },
        ];
        const { calls, fetch } = recorder(() => Response.json({ jobs }, { status: 200 }));
        const board = boardOn(fetch, 'fwt_abc');

        expect(await board.leases([ID_A, ID_B])).toEqual(jobs);
        expect(calls[0]!.url).toBe('http://board/api/jobs/leases');
        expect(calls[0]!.body).toEqual({ ids: [ID_A, ID_B] });
        expect(calls[0]!.headers.authorization).toBe('Bearer fwt_abc');
    });

    it('omits the bearer header against an open board, like every other call', async () => {
        const { calls, fetch } = recorder(() => Response.json({ jobs: [] }, { status: 200 }));
        const board = boardOn(fetch);

        await board.leases([ID_A]);

        expect(calls[0]!.headers).not.toHaveProperty('authorization');
    });

    it('answers null — reap nothing — when the board refuses or fails', async () => {
        const refused = recorder(() => Response.json({ error: 'boom' }, { status: 500 }));
        expect(await boardOn(refused.fetch).leases([ID_A])).toBeNull();

        const broken = recorder(() => {
            throw new Error('board unreachable');
        });
        expect(await boardOn(broken.fetch).leases([ID_A])).toBeNull();
    });

    it('answers null when ANY row is unreadable — a partial answer is a reap verdict, never trusted', async () => {
        const { fetch } = recorder(() =>
            Response.json(
                {
                    jobs: [
                        { id: ID_A, status: 'dead', leaseToken: null },
                        { id: ID_B, status: 'ZOMBIE', leaseToken: null },
                        { id: 'not-a-uuid', status: 'dead', leaseToken: null },
                        { status: 'dead', leaseToken: null },
                        'junk',
                    ],
                },
                { status: 200 }
            )
        );
        const board = boardOn(fetch);

        // The one readable row is NOT passed through: "absent means unknown" is a reap verdict,
        // and a malformed row must not be silently converted into it.
        expect(await board.leases([ID_A])).toBeNull();
    });
});

describe('the heartbeat verdict', () => {
    const job = boardJob();

    it('carries the stop flag when the board set it on a held lease', async () => {
        const { calls, fetch } = recorder(() => Response.json({ cancelRequested: true }, { status: 200 }));
        const board = boardOn(fetch);

        expect(await board.heartbeat(job)).toEqual({
            result: 'held',
            cancelRequested: true,
            answeredQuestions: [],
        });
        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1/heartbeat');
        expect(calls[0]!.body).toEqual({ leaseToken: 'token-1', leaseSeconds: 300 });
    });

    it('answers held without the stop flag when the board never set one', async () => {
        const { fetch } = recorder(() => Response.json({}, { status: 200 }));
        const board = boardOn(fetch);
        expect(await board.heartbeat(job)).toEqual({ result: 'held', cancelRequested: false, answeredQuestions: [] });
    });

    it('carries the answered questions the board lists on a held lease', async () => {
        const answeredQuestions = [{ questionId: 'toolu_1', answers: { 'Which colour?': 'Blue' } }];
        const { fetch } = recorder(() => Response.json({ cancelRequested: false, answeredQuestions }));
        const board = boardOn(fetch);
        expect(await board.heartbeat(job)).toEqual({ result: 'held', cancelRequested: false, answeredQuestions });
    });

    it('reads an answeredQuestions that is not a list as none', async () => {
        const { fetch } = recorder(() => Response.json({ answeredQuestions: 'x' }));
        const board = boardOn(fetch);
        expect(await board.heartbeat(job)).toEqual({ result: 'held', cancelRequested: false, answeredQuestions: [] });
    });

    it('answers lost on a 409, which is a verdict not a failure', async () => {
        const { fetch } = recorder(() => Response.json({ error: 'Lease lost' }, { status: 409 }));
        const board = boardOn(fetch);
        expect(await board.heartbeat(job)).toBe('lost');
    });

    it('answers removed on a 404 — the thread was deleted while this attempt ran', async () => {
        // The only 404 a heartbeat can see is a Remove; the driver kills the container and
        // reports nothing, so the status has to arrive as a verdict rather than "board broken".
        const { fetch } = recorder(() => Response.json({ error: 'No such job' }, { status: 404 }));
        const board = boardOn(fetch);
        expect(await board.heartbeat(job)).toBe('removed');
    });
});

describe('the question calls', () => {
    const job = boardJob();
    const questions = [
        {
            question: 'Which colour?',
            header: 'Colour',
            multiSelect: false,
            options: [{ label: 'Blue' }, { label: 'Red' }],
        },
    ];
    const board = (status: number, body: unknown = {}) => {
        const { calls, fetch } = recorder(() => Response.json(body, { status }));
        return { calls, board: boardOn(fetch) };
    };

    it('reports a question under the lease token and answers held for 201 and 200', async () => {
        for (const status of [201, 200]) {
            const { calls, board: b } = board(status);
            expect(await b.question(job, 'toolu_1', questions)).toBe('held');
            expect(calls[0]!.url).toBe('http://board/api/jobs/job-1/question');
            expect(calls[0]!.body).toEqual({ leaseToken: 'token-1', questionId: 'toolu_1', questions });
        }
    });

    it('reads the question limit (429) as refused, a 409 as lost and a 404 as removed', async () => {
        expect(await board(429).board.question(job, 'toolu_1', questions)).toBe('refused');
        expect(await board(409).board.question(job, 'toolu_1', questions)).toBe('lost');
        expect(await board(404).board.question(job, 'toolu_1', questions)).toBe('removed');
    });

    it('throws on a 5xx so the caller retries', async () => {
        await expect(board(503).board.question(job, 'toolu_1', questions)).rejects.toThrow(/503/);
    });
});

describe('the removed-thread reclaim queue', () => {
    it('claims a row with the worker and lease, answering null on an empty queue', async () => {
        const row = {
            id: '55555555-5555-4555-8555-555555555555',
            rootJobId: 'job-1',
            repo: 'Bellows-AI/factory',
            workspacePath: 'bellows/user-7',
            leaseExpiresAt: '2026-08-21T12:05:00.000Z',
        };
        const { calls, fetch } = recorder(() => Response.json(row, { status: 200 }));
        const board = boardOn(fetch);

        expect(await board.claimReclaim('driver-1')).toEqual(row);
        expect(calls[0]!.url).toBe('http://board/api/reclaims/claim');
        expect(calls[0]!.body).toEqual({ worker: 'driver-1', leaseSeconds: 300 });

        const { fetch: idle } = recorder(() => new Response(null, { status: 204 }));
        const idleBoard = boardOn(idle);
        expect(await idleBoard.claimReclaim('driver-1')).toBeNull();
    });

    it('acks a consumed row as ok, and reads 409 and 404 back as their own verdicts', async () => {
        const ok = recorder(() => Response.json({ id: 'row-1' }, { status: 200 }));
        const board = boardOn(ok.fetch, 'fwt_abc');
        expect(await board.ackReclaim('row-1', 'driver-1')).toBe('ok');
        expect(ok.calls[0]!.url).toBe('http://board/api/reclaims/row-1/ack');
        expect(ok.calls[0]!.body).toEqual({ worker: 'driver-1' });
        expect(ok.calls[0]!.headers.authorization).toBe('Bearer fwt_abc');

        const lost = recorder(() => Response.json({ error: 'Lease lost' }, { status: 409 }));
        expect(await boardOn(lost.fetch).ackReclaim('row-1', 'driver-1')).toBe('lost');

        const gone = recorder(() => Response.json({ error: 'No such reclaim' }, { status: 404 }));
        expect(await boardOn(gone.fetch).ackReclaim('row-1', 'driver-1')).toBe('missing');
    });

    it('still throws on any other non-ok answer', async () => {
        const { fetch } = recorder(() => Response.json({ error: 'boom' }, { status: 500 }));
        const board = boardOn(fetch);

        await expect(board.ackReclaim('row-1', 'driver-1')).rejects.toThrow(/500/);
    });
});

describe('the complete verdict', () => {
    const job = boardJob();

    it('carries the thread-done answer the board computed beside the lease state', async () => {
        // The board computes threadDone in the same lease-guarded transaction as the verdict,
        // so the driver reads both from the one complete round trip — no separate thread read to
        // race a follow-up's insertion against.
        const { calls, fetch } = recorder(() =>
            Response.json({ id: 'job-1', status: 'succeeded', threadDone: true }, { status: 200 })
        );
        const board = boardOn(fetch, 'fwt_abc');

        const verdict = await board.complete(job, { status: 'succeeded', exitCode: 0, output: '' });

        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1/complete');
        expect(calls[0]!.headers.authorization).toBe('Bearer fwt_abc');
        expect(verdict).toEqual({ state: 'held', threadDone: true });
    });

    // Defensive on purpose: a board that predates the field, a body without it, or one that
    // lies about its type all mean "a follow-up might still come" — the conservative answer.
    it.each<[string, Record<string, unknown>]>([
        ['an absent', { id: 'job-1', status: 'succeeded' }],
        ['a false', { id: 'job-1', threadDone: false }],
        ['a non-boolean', { id: 'job-1', threadDone: 'yes' }],
    ])('reads %s threadDone as false — keep the tree', async (_label, body) => {
        const { fetch } = recorder(() => Response.json(body, { status: 200 }));
        expect(await boardOn(fetch).complete(job, { status: 'succeeded', exitCode: 0, output: '' })).toEqual({
            state: 'held',
            threadDone: false,
        });
    });

    it('answers lost with threadDone false when the board refuses the verdict with a 409', async () => {
        const { fetch } = recorder(() => Response.json({ error: 'Lease lost' }, { status: 409 }));
        const board = boardOn(fetch);

        expect(await board.complete(job, { status: 'failed', exitCode: 1, output: 'boom' })).toEqual({
            state: 'lost',
            threadDone: false,
        });
    });

    it('still throws on any other non-ok answer', async () => {
        // 409 is a verdict; everything else is the board being broken or the driver being wrong,
        // and neither is swallowed into a silent no-op.
        const { fetch } = recorder(() => Response.json({ error: 'No such job' }, { status: 404 }));
        const board = boardOn(fetch);

        await expect(board.complete(job, { status: 'succeeded', exitCode: 0, output: '' })).rejects.toThrow(/404/);
    });

    it('carries failureKind on the wire when the verdict names one, and no key when it does not', async () => {
        // The structured failure kind (issue #339) rides the verdict like agentTurns does: present
        // only when there is one, so a success or a pre-column row is stored null, never zero-ish.
        const { calls, fetch } = recorder(() => Response.json({ id: 'job-1', threadDone: false }, { status: 200 }));
        const board = boardOn(fetch);

        await board.complete(job, { status: 'failed', exitCode: null, output: 'killed', failureKind: 'timeout' });
        expect(calls[0]!.body).toMatchObject({ failureKind: 'timeout' });

        await board.complete(job, { status: 'succeeded', exitCode: 0, output: 'done' });
        expect(calls[1]!.body).not.toHaveProperty('failureKind');
    });

    it('carries failureCause beside the kind when set, and no key when null or absent (#581)', async () => {
        const { calls, fetch } = recorder(() => Response.json({ id: 'job-1', threadDone: false }, { status: 200 }));
        const board = boardOn(fetch);

        await board.complete(job, {
            status: 'failed',
            exitCode: 1,
            output: 'rejected',
            failureKind: 'publish',
            failureCause: 'conflict',
        });
        expect(calls[0]!.body).toMatchObject({ failureKind: 'publish', failureCause: 'conflict' });

        await board.complete(job, {
            status: 'failed',
            exitCode: null,
            output: 'k',
            failureKind: 'timeout',
            failureCause: null,
        });
        expect(calls[1]!.body).not.toHaveProperty('failureCause');

        await board.complete(job, { status: 'succeeded', exitCode: 0, output: 'done' });
        expect(calls[2]!.body).not.toHaveProperty('failureCause');
    });

    it('no longer carries a separate thread read — the answer travels on complete', () => {
        const board = boardOn(recorder(() => claimed()).fetch);
        expect('threadDone' in board).toBe(false);
    });
});
