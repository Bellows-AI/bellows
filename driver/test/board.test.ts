import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createBoard, type VerdictEvidence } from '../src/board.js';
import { BoardHttpError } from '../src/board-retry.js';
import { COMPLETE_BODY_LIMIT_BYTES } from '../src/verdict-budget.js';
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
        // Issue #774: the claim names the reviewer profiles the pod must hold a reviewer for.
        ['carries the reviewer profile names', { reviewerProfiles: ['security'] }, 'reviewerProfiles', ['security']],
        ['reads missing reviewer profiles as absent', {}, 'reviewerProfiles', undefined],
        ['drops an empty reviewerProfiles list', { reviewerProfiles: [] }, 'reviewerProfiles', undefined],
        ['drops a malformed reviewerProfiles value', { reviewerProfiles: ['a', 1] }, 'reviewerProfiles', undefined],
        // Issue #769: the claim carries the resolved execution plan; a malformed services value is a
        // refusal sentence, never a half-read fleet.
        [
            'carries the services the board resolved',
            { services: [{ name: 'db', image: 'postgres:16', environment: [], ports: [5432] }] },
            'services',
            [{ name: 'db', image: 'postgres:16', environment: [], ports: [5432] }],
        ],
        ['reads missing services as absent', {}, 'services', ABSENT],
        ['reads a missing planRefusal as null', {}, 'planRefusal', null],
        ['carries the board’s plan refusal', { planRefusal: 'bad plan' }, 'planRefusal', 'bad plan'],
        ['drops a malformed services value', { services: [{ name: 1 }] }, 'services', ABSENT],
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

    it('turns a malformed services value into a plan refusal sentence', async () => {
        const { fetch } = recorder(() => claimed({ services: [{ name: 1 }] }));
        const job = await boardOn(fetch).claim('driver-1');
        expect(job).not.toHaveProperty('services');
        expect(typeof job?.planRefusal).toBe('string');
        expect(job?.planRefusal).not.toBe('');
    });
});

describe('asking for the attempt’s GitHub token (docs/connections.md)', () => {
    const job = boardJob();

    it('asks the credential endpoint with the attempt pair, never the board secret', async () => {
        const { calls, fetch } = recorder(() =>
            Response.json({ token: 'ghs_fresh', expiresAt: '2026-10-16T13:00:00.000Z' }, { status: 200 })
        );
        const board = boardOn(fetch, 'fwt_abc');

        const token = await board.githubCredential(job);

        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1/credentials/github');
        expect(calls[0]!.headers).toEqual({ 'x-factory-job-id': 'job-1', 'x-factory-job-lease-token': 'token-1' });
        expect(calls[0]!.headers.authorization).toBeUndefined();
        expect(token).toBe('ghs_fresh');
    });

    it('answers null when the board has no App, refuses the attempt, or fails', async () => {
        const noApp = recorder(() => Response.json({ code: 'GITHUB_UNAVAILABLE' }, { status: 409 }));
        expect(await boardOn(noApp.fetch).githubCredential(job)).toBeNull();

        const refused = recorder(() => Response.json({ code: 'CONNECTION_NOT_AUTHORIZED' }, { status: 403 }));
        expect(await boardOn(refused.fetch).githubCredential(job)).toBeNull();

        const empty = recorder(() => Response.json({ token: '' }, { status: 200 }));
        expect(await boardOn(empty.fetch).githubCredential(job)).toBeNull();

        const broken = recorder(() => {
            throw new Error('board unreachable');
        });
        expect(await boardOn(broken.fetch).githubCredential(job)).toBeNull();
    });

    // A push with no token is a lost PR on a private repository: a transient board failure is retried.
    it('retries a failed request, a 5xx and a 429 a bounded number of times before it answers null', async () => {
        let n = 0;
        const flaky = recorder(() => {
            n += 1;
            if (n === 1) throw new Error('board unreachable');
            if (n === 2) return Response.json({}, { status: 502 });
            return Response.json({ token: 'ghs_after_retry' }, { status: 200 });
        });
        expect(await boardOn(flaky.fetch).githubCredential(job)).toBe('ghs_after_retry');
        expect(flaky.calls).toHaveLength(3);

        const busy = recorder(() => Response.json({}, { status: 429 }));
        expect(await boardOn(busy.fetch).githubCredential(job)).toBeNull();
        expect(busy.calls).toHaveLength(3);
    });

    it('never retries an answer: a refused attempt or no App is asked once', async () => {
        for (const status of [403, 409]) {
            const answered = recorder(() => Response.json({}, { status }));
            expect(await boardOn(answered.fetch).githubCredential(job)).toBeNull();
            expect(answered.calls).toHaveLength(1);
        }
    });
});

describe('reporting an interrupted attempt (issue #792)', () => {
    const job = boardJob();

    it('posts the reason, the release and the adopted claim sequence under the lease', async () => {
        const { calls, fetch } = recorder(() => Response.json({ id: 'job-1', status: 'queued' }, { status: 200 }));

        expect(await boardOn(fetch).interrupt(job, { reason: 'evicted', release: true })).toBe('held');
        expect(await boardOn(fetch).interrupt(job, { reason: 'adopted', release: false, claimSeq: 2 })).toBe('held');

        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1/interrupt');
        expect(calls[0]!.body).toEqual({ leaseToken: 'token-1', reason: 'evicted', release: true });
        expect(calls[1]!.body).toEqual({ leaseToken: 'token-1', reason: 'adopted', release: false, claimSeq: 2 });
    });

    it('tells a spent budget apart from a lost lease, and reads a removed job as lost', async () => {
        const spent = recorder(() => Response.json({ code: 'INTERRUPTIONS_EXHAUSTED' }, { status: 409 }));
        expect(await boardOn(spent.fetch).interrupt(job, { reason: 'evicted', release: true })).toBe('exhausted');

        const lost = recorder(() => Response.json({ code: 'LEASE_LOST' }, { status: 409 }));
        expect(await boardOn(lost.fetch).interrupt(job, { reason: 'evicted', release: true })).toBe('lost');

        const gone = recorder(() => Response.json({ error: 'No such job' }, { status: 404 }));
        expect(await boardOn(gone.fetch).interrupt(job, { reason: 'evicted', release: true })).toBe('lost');
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

    it('asks for thread facts with threads: true, and only when told to', async () => {
        const { calls, fetch } = recorder(() => Response.json({ jobs: [] }, { status: 200 }));
        const board = boardOn(fetch);

        await board.leases([ID_A], true);

        expect(calls[0]!.body).toEqual({ ids: [ID_A], threads: true });
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

    describe('the thread facts of a root row (issue #775)', () => {
        const THREAD = {
            live: false,
            lastFinalizedAt: '2026-10-01T00:00:00.000Z',
            artifactsComplete: true,
            checkpoint: 'complete',
            checkpointFinalizedAt: '2026-10-01T00:00:00.000Z',
        };
        const answerWith = (thread: unknown) =>
            boardOn(
                recorder(() => Response.json({ jobs: [{ id: ID_A, status: 'succeeded', leaseToken: null, thread }] }))
                    .fetch
            ).leases([ID_A]);

        it('carries a well-formed thread beside the lease, and a null time as null', async () => {
            expect(await answerWith(THREAD)).toEqual([
                { id: ID_A, status: 'succeeded', leaseToken: null, thread: THREAD },
            ]);
            const open = { ...THREAD, lastFinalizedAt: null, checkpoint: 'none', checkpointFinalizedAt: null };
            expect(await answerWith(open)).toEqual([{ id: ID_A, status: 'succeeded', leaseToken: null, thread: open }]);
        });

        it.each([
            ['a thread that is null', null],
            ['a thread that is a string', 'complete'],
            ['a missing live', { ...THREAD, live: undefined }],
            ['a live that is no boolean', { ...THREAD, live: 'no' }],
            ['a missing artifactsComplete', { ...THREAD, artifactsComplete: undefined }],
            ['an unknown checkpoint', { ...THREAD, checkpoint: 'partial' }],
            ['a missing checkpoint', { ...THREAD, checkpoint: undefined }],
            ['a lastFinalizedAt that is no date', { ...THREAD, lastFinalizedAt: 'soon' }],
            ['a missing lastFinalizedAt', { ...THREAD, lastFinalizedAt: undefined }],
            ['a checkpointFinalizedAt that is a number', { ...THREAD, checkpointFinalizedAt: 5 }],
            ['a missing checkpointFinalizedAt', { ...THREAD, checkpointFinalizedAt: undefined }],
        ])('answers null — the whole round aborts — on %s', async (_name, thread) => {
            expect(await answerWith(thread)).toBeNull();
        });
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
    const TOKEN = '66666666-6666-4666-8666-666666666666';

    it("claims a row with the worker and lease, carrying the acquisition's token, and answers null on an empty queue", async () => {
        const row = {
            id: '55555555-5555-4555-8555-555555555555',
            token: TOKEN,
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

    it('acks a consumed row under its token as ok, and reads 409 and 404 back as their own verdicts', async () => {
        const ok = recorder(() => Response.json({ id: 'row-1' }, { status: 200 }));
        const board = boardOn(ok.fetch, 'fwt_abc');
        expect(await board.ackReclaim('row-1', TOKEN)).toBe('ok');
        expect(ok.calls[0]!.url).toBe('http://board/api/reclaims/row-1/ack');
        expect(ok.calls[0]!.body).toEqual({ token: TOKEN });
        expect(ok.calls[0]!.headers.authorization).toBe('Bearer fwt_abc');

        const lost = recorder(() => Response.json({ error: 'Lease lost' }, { status: 409 }));
        expect(await boardOn(lost.fetch).ackReclaim('row-1', TOKEN)).toBe('lost');

        const gone = recorder(() => Response.json({ error: 'No such reclaim' }, { status: 404 }));
        expect(await boardOn(gone.fetch).ackReclaim('row-1', TOKEN)).toBe('missing');
    });

    it("renews a row under its token for the driver's lease, reading 200, 409 and 404 as held, lost and missing", async () => {
        const held = recorder(() => Response.json({ leaseExpiresAt: '2026-08-21T12:10:00.000Z' }, { status: 200 }));
        const board = boardOn(held.fetch, 'fwt_abc');
        expect(await board.renewReclaim('row-1', TOKEN)).toBe('held');
        expect(held.calls[0]!.url).toBe('http://board/api/reclaims/row-1/renew');
        expect(held.calls[0]!.body).toEqual({ token: TOKEN, leaseSeconds: 300 });
        expect(held.calls[0]!.headers.authorization).toBe('Bearer fwt_abc');

        let seen: AbortSignal | null | undefined;
        const bounded = (async (_url: string, init: RequestInit) => {
            seen = init.signal;
            return Response.json({ leaseExpiresAt: '2026-08-21T12:10:00.000Z' }, { status: 200 });
        }) as unknown as typeof globalThis.fetch;
        const deadline = AbortSignal.timeout(60_000);
        expect(await boardOn(bounded).renewReclaim('row-1', TOKEN, deadline)).toBe('held');
        expect(seen).toBe(deadline);

        const lost = recorder(() => Response.json({ error: 'Reclaim is not yours' }, { status: 409 }));
        expect(await boardOn(lost.fetch).renewReclaim('row-1', TOKEN)).toBe('lost');

        const gone = recorder(() => Response.json({ error: 'No such reclaim' }, { status: 404 }));
        expect(await boardOn(gone.fetch).renewReclaim('row-1', TOKEN)).toBe('missing');
    });

    it('still throws on any other non-ok answer', async () => {
        const { fetch } = recorder(() => Response.json({ error: 'boom' }, { status: 500 }));
        const board = boardOn(fetch);

        await expect(board.ackReclaim('row-1', TOKEN)).rejects.toThrow(/500/);
        await expect(board.renewReclaim('row-1', TOKEN)).rejects.toThrow(/500/);
    });
});

describe('the complete verdict', () => {
    const job = boardJob();

    it('carries the verdict-time reclaim the board queued beside the lease state', async () => {
        // The board queues a done thread's reclaim, claimed by this worker, in the same
        // lease-guarded transaction as the verdict (issue #821), so the driver reads both from the
        // one complete round trip — no separate thread read to race a follow-up's insertion against.
        const { calls, fetch } = recorder(() =>
            Response.json(
                { id: 'job-1', status: 'succeeded', threadDone: true, reclaimId: 'reclaim-1' },
                { status: 200 }
            )
        );
        const board = boardOn(fetch, 'fwt_abc');

        const verdict = await board.complete(job, { status: 'succeeded', exitCode: 0, output: '' });

        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1/complete');
        expect(calls[0]!.headers.authorization).toBe('Bearer fwt_abc');
        expect(verdict).toEqual({ state: 'held', reclaimId: 'reclaim-1' });
    });

    // Defensive on purpose: a body without the field, or one that lies about its type, means
    // "no reclaim was ordered" — the tree stays, the conservative answer.
    it.each<[string, Record<string, unknown>]>([
        ['an absent', { id: 'job-1', status: 'succeeded', threadDone: true }],
        ['a null', { id: 'job-1', threadDone: false, reclaimId: null }],
        ['a non-string', { id: 'job-1', threadDone: true, reclaimId: 7 }],
        ['an empty', { id: 'job-1', threadDone: true, reclaimId: '' }],
    ])('reads %s reclaimId as no reclaim — keep the tree', async (_label, body) => {
        const { fetch } = recorder(() => Response.json(body, { status: 200 }));
        expect(await boardOn(fetch).complete(job, { status: 'succeeded', exitCode: 0, output: '' })).toEqual({
            state: 'held',
            reclaimId: null,
        });
    });

    it('answers lost with no reclaim when the board refuses the verdict with a 409', async () => {
        const { fetch } = recorder(() => Response.json({ error: 'Lease lost' }, { status: 409 }));
        const board = boardOn(fetch);

        expect(await board.complete(job, { status: 'failed', exitCode: 1, output: 'boom' })).toEqual({
            state: 'lost',
            reclaimId: null,
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

describe('the complete verdict: a refusal the board means', () => {
    it.each([400, 413])(
        'throws a BoardHttpError carrying the %i, so the retry can tell it is deterministic',
        async (status) => {
            const { fetch } = recorder(() => Response.json({ error: 'no' }, { status }));

            const refused = boardOn(fetch).complete(boardJob(), { status: 'succeeded', exitCode: 0, output: '' });

            await expect(refused).rejects.toBeInstanceOf(BoardHttpError);
            await expect(refused).rejects.toMatchObject({ status });
        }
    );
});

describe('the complete verdict: the request budget', () => {
    /** Captures the raw request bytes, which are what the route's body limit measures. */
    function rawRecorder() {
        const bodies: string[] = [];
        const fetch = (async (_url: string, init: RequestInit) => {
            bodies.push(init.body as string);
            return Response.json({ threadDone: false }, { status: 200 });
        }) as unknown as typeof globalThis.fetch;
        return { bodies, fetch };
    }
    const publication = {
        repo: 'o/r',
        prNumber: 1,
        prUrl: 'https://github.com/o/r/pull/1',
        headBranch: 'fix/1',
        baseBranch: 'main',
    };
    const evidence = { gates: 'passed' } as unknown as VerdictEvidence;
    const note = '\n[driver] published fix/1 — https://github.com/o/r/pull/1';

    it('is the route limit the board enforces', () => {
        const limits = readFileSync(new URL('../../server/src/routes/job-limits.ts', import.meta.url), 'utf8');
        expect(limits).toContain('const BODY_LIMIT_KIB = 128;');
        expect(COMPLETE_BODY_LIMIT_BYTES).toBe(128 * 1024);
    });

    it.each([
        ['control characters, six bytes each once escaped', '\u0001'],
        ['quotes and backslashes, two bytes each', '"\\'],
        ['CJK text, three bytes each', '漢字'],
    ])(
        'fits %s plus the notes into the limit, keeping the newest output and the structured fields',
        async (_l, unit) => {
            const { bodies, fetch } = rawRecorder();
            const output = `${unit.repeat(40_000)}\n[gate test] FAILED\n${unit.repeat(20_000)}${note}`;

            await boardOn(fetch).complete(boardJob(), {
                status: 'succeeded',
                exitCode: 0,
                output,
                summary: 'x'.repeat(10_000),
                failureCause: 'transport',
                evidence,
                publication,
            });

            expect(Buffer.byteLength(bodies[0]!)).toBeLessThanOrEqual(COMPLETE_BODY_LIMIT_BYTES);
            const sent = JSON.parse(bodies[0]!) as Record<string, unknown>;
            expect(sent.output).toMatch(
                /^\[driver\] \d+ bytes of the oldest output were dropped to fit the board's request limit\n/
            );
            expect((sent.output as string).endsWith(note)).toBe(true);
            expect(sent).toMatchObject({ status: 'succeeded', publication, evidence, failureCause: 'transport' });
            expect(sent.leaseToken).toBe('token-1');
        }
    );

    it('sends an output under the limit byte for byte — the board truncates long fields itself', async () => {
        const { bodies, fetch } = rawRecorder();
        const output = 'a'.repeat(100_000);

        await boardOn(fetch).complete(boardJob(), { status: 'failed', exitCode: 1, output, summary: 's' });

        expect(JSON.parse(bodies[0]!)).toMatchObject({ output, summary: 's' });
    });
});

// Issue #821 (D1): the final envelope is staged on the board under the lease before the verdict and
// the teardown — the very body `complete` sends, so the board's fingerprint of both is one.
describe('the staged conclusion', () => {
    const job = boardJob();
    const verdict = {
        status: 'failed',
        exitCode: 1,
        output: 'boom',
        failureKind: 'gate',
        failureCause: 'verification',
    } as const;

    it('posts complete’s fitted body to the conclusion route, with the lease length beside it', async () => {
        const { calls, fetch } = recorder(() => Response.json({ id: 'job-1', status: 'failed' }, { status: 200 }));
        const board = boardOn(fetch, 'fwt_abc');

        expect(await board.stageConclusion(job, verdict)).toBe('held');
        await board.complete(job, verdict);

        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1/conclusion');
        expect(calls[0]!.headers.authorization).toBe('Bearer fwt_abc');
        expect(calls[0]!.body).toEqual({ ...(calls[1]!.body as object), leaseSeconds: 300 });
    });

    it('fits a long output exactly as complete does', async () => {
        const { calls, fetch } = recorder(() => Response.json({ threadDone: false }, { status: 200 }));
        const board = boardOn(fetch);
        const long = { status: 'failed', exitCode: 1, output: '\u0001'.repeat(60_000) } as const;

        await board.stageConclusion(job, long);
        await board.complete(job, long);

        const { leaseSeconds: _lease, ...staged } = calls[0]!.body as Record<string, unknown>;
        expect(staged).toEqual(calls[1]!.body);
        expect(staged.output).toMatch(/^\[driver\] \d+ bytes of the oldest output were dropped/);
    });

    it.each<[string, string, number, Record<string, unknown>]>([
        ['a lost lease', 'lost', 409, { code: 'LEASE_LOST' }],
        ['a different staged conclusion', 'conflict', 409, { code: 'CONCLUSION_CONFLICT' }],
        ['a removed thread', 'removed', 404, { code: 'NOT_FOUND' }],
    ])('reads %s as %s', async (_what, answer, status, body) => {
        const { fetch } = recorder(() => Response.json(body, { status }));

        expect(await boardOn(fetch).stageConclusion(job, verdict)).toBe(answer);
    });

    it('throws a 5xx for the retry to take', async () => {
        const { fetch } = recorder(() => Response.json({ error: 'down' }, { status: 503 }));

        await expect(boardOn(fetch).stageConclusion(job, verdict)).rejects.toMatchObject({ status: 503 });
    });

    it('is a route limit the board leaves room for beside complete’s', () => {
        const limits = readFileSync(new URL('../../server/src/routes/job-limits.ts', import.meta.url), 'utf8');
        expect(limits).toContain('export const CONCLUSION_BODY_LIMIT = BODY_LIMIT + CONTROL_BODY_LIMIT;');
    });

    it('reads a complete the staged conclusion refuses as lost, flagged as the conflict', async () => {
        const { fetch } = recorder(() => Response.json({ code: 'CONCLUSION_CONFLICT' }, { status: 409 }));

        expect(await boardOn(fetch).complete(job, verdict)).toEqual({ state: 'lost', reclaimId: null, conflict: true });
    });
});

describe('the phase checkpoints (issue #829)', () => {
    const job = boardJob();
    const row = { phase: 'gates', claimSeq: 2, tree: 'h:2', result: { verdict: 'passed' } };

    it('writes a checkpoint under the lease token and reads the run’s back', async () => {
        const write = recorder(() => Response.json({ id: 'job-1', phase: 'gates' }));
        const board = boardOn(write.fetch, 'fwt_abc');
        expect(
            await board.phaseCheckpoint(job, {
                runClaimSeq: 2,
                phase: 'gates',
                tree: 'h:2',
                result: { verdict: 'passed' },
            })
        ).toBe('ok');
        expect(write.calls[0]!.url).toBe('http://board/api/jobs/job-1/phase-checkpoint');
        expect(write.calls[0]!.headers.authorization).toBe('Bearer fwt_abc');
        expect(write.calls[0]!.body).toEqual({
            leaseToken: job.leaseToken,
            runClaimSeq: 2,
            phase: 'gates',
            tree: 'h:2',
            result: { verdict: 'passed' },
        });

        const read = recorder(() => Response.json({ checkpoints: [row] }));
        expect(await boardOn(read.fetch).phaseCheckpoints(job, 2)).toEqual([row]);
        expect(read.calls[0]!.url).toBe('http://board/api/jobs/job-1/phase-checkpoints');
        expect(read.calls[0]!.body).toEqual({ leaseToken: job.leaseToken, runClaimSeq: 2 });
    });

    it('reads an empty answer as no checkpoints, not as an unreadable one', async () => {
        const { fetch } = recorder(() => Response.json({ checkpoints: [] }));
        expect(await boardOn(fetch).phaseCheckpoints(job, 2)).toEqual([]);
    });

    it.each<[string, () => Response]>([
        ['a 409', () => Response.json({ code: 'LEASE_LOST' }, { status: 409 })],
        ['a 404', () => Response.json({ code: 'NOT_FOUND' }, { status: 404 })],
        ['a 500', () => Response.json({ error: 'down' }, { status: 500 })],
        ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
        ['no checkpoints field', () => Response.json({})],
        ['an unknown phase', () => Response.json({ checkpoints: [{ ...row, phase: 'merge' }] })],
        ['a fractional claim', () => Response.json({ checkpoints: [{ ...row, claimSeq: 1.5 }] })],
        ['a numeric tree', () => Response.json({ checkpoints: [{ ...row, tree: 7 }] })],
        ['a duplicated phase', () => Response.json({ checkpoints: [row, row] })],
        ['a row that is not an object', () => Response.json({ checkpoints: [null] })],
    ])('reads %s as unreadable, never as empty', async (_what, respond) => {
        const { fetch } = recorder(respond);
        expect(await boardOn(fetch).phaseCheckpoints(job, 2)).toBeNull();
    });

    it('reads a rejected fetch and an aborted signal as unreadable', async () => {
        const failing = (async () => {
            throw new Error('connection reset');
        }) as unknown as typeof globalThis.fetch;
        expect(await boardOn(failing).phaseCheckpoints(job, 2)).toBeNull();
        const { fetch } = recorder(() => Response.json({ checkpoints: [row] }));
        const aborted = AbortSignal.abort();
        const slow = ((_url: string, init: RequestInit) =>
            init.signal?.aborted ? Promise.reject(init.signal.reason) : fetch(_url, init)) as unknown as typeof fetch;
        expect(await boardOn(slow).phaseCheckpoints(job, 2, aborted)).toBeNull();
    });

    it.each<[string, () => Response, string]>([
        ['a lost lease', () => Response.json({ code: 'LEASE_LOST' }, { status: 409 }), 'lost'],
        [
            'a conflicting run claim',
            () => Response.json({ code: 'PHASE_CHECKPOINT_CONFLICT' }, { status: 409 }),
            'rejected',
        ],
        ['a removed thread', () => Response.json({ code: 'NOT_FOUND' }, { status: 404 }), 'lost'],
        ['a 400', () => Response.json({ code: 'BAD_BODY' }, { status: 400 }), 'rejected'],
        ['a 500', () => Response.json({ error: 'down' }, { status: 500 }), 'rejected'],
    ])('answers a write refused with %s as %s', async (_what, respond, answer) => {
        const { fetch } = recorder(respond);
        expect(
            await boardOn(fetch).phaseCheckpoint(job, { runClaimSeq: 2, phase: 'gates', tree: null, result: {} })
        ).toBe(answer);
    });

    it('never throws on a rejected fetch', async () => {
        const failing = (async () => {
            throw new Error('connection reset');
        }) as unknown as typeof globalThis.fetch;
        expect(
            await boardOn(failing).phaseCheckpoint(job, { runClaimSeq: 2, phase: 'gates', tree: null, result: {} })
        ).toBe('rejected');
    });
});
