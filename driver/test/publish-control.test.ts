import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { createGateServer, type GateClaim } from '../src/gates.js';
import { newJobState } from '../src/loop/loop-attempt.js';
import { recordEnding, transition } from '../src/loop/loop-phase.js';
import { createPublishRelay } from '../src/loop/loop-publish.js';
import { publishWithRetry } from '../src/loop/loop-publish-retry.js';
import type { LoopRuntime } from '../src/loop/loop-types.js';
import { type PublishResult, publishFailed, type TreeProbe } from '../src/publish/publish.js';
import type { PublishRelay, PublishVerdict } from '../src/publish/publish-control.js';
import type { PublishOptions } from '../src/publish/publish.js';

const OK_STATUS = 200;
const UNAUTHORIZED_STATUS = 401;
const FORBIDDEN_STATUS = 403;
const NOT_FOUND_STATUS = 404;
const CONFLICT_STATUS = 409;
const PAYLOAD_TOO_LARGE_STATUS = 413;
const NOT_IMPLEMENTED_STATUS = 501;
const BAD_GATEWAY_STATUS = 502;

const JOB = {
    id: '00000001-1111-4111-8111-111111111111',
    command: 'job 1',
    leaseToken: '00000001-2222-4222-8222-222222222222',
} as BoardJob;

const LANDED: PublishResult = {
    ok: true,
    published: true,
    branch: 'fix/10',
    prUrl: 'https://github.com/Bellows-AI/bellows/pull/42',
    reason: null,
    cause: null,
    repository: 'Bellows-AI/bellows',
    baseBranch: 'main',
    prNumber: 42,
};

const manager = { acquire: async () => {}, runGate: async () => ({ exitCode: 0, output: '' }) };

describe('the control server: POST /publish', () => {
    const post = (port: number, token: string, body = '') =>
        fetch(`http://127.0.0.1:${port}/publish`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            body,
        });

    async function opened(relay: PublishRelay | undefined) {
        const server = createGateServer({ host: '127.0.0.1', manager });
        // 'tok-p' is the AGENT's token: the publish route is one of the two the agent holds a door to.
        server.openControl('tok-p-supervisor', undefined, relay);
        server.grantAgent('tok-p-supervisor', 'tok-p');
        return { server, port: await server.listen() };
    }

    it('answers what the relay published', async () => {
        const { server, port } = await opened({ publish: async () => LANDED });
        const answer = await post(port, 'tok-p');
        expect(answer.status).toBe(OK_STATUS);
        await expect(answer.json()).resolves.toEqual({
            published: true,
            branch: 'fix/10',
            prUrl: LANDED.prUrl,
            prNumber: 42,
            reason: null,
        });
        await server.close();
    });

    it('names the operation the publish performed', async () => {
        const operationId = '88888888-8888-4888-8888-888888888888';
        const { server, port } = await opened({ publish: async () => ({ ...LANDED, operationId }) });
        const answer = await post(port, 'tok-p');
        await expect(answer.json()).resolves.toMatchObject({ prNumber: 42, operationId });
        await server.close();
    });

    // A row with a body pins the answer's JSON too: a refusal the evidence policy made and a stale
    // checkout are 409s carrying the reason, a failed push a 502 carrying its reason.
    it.each<[PublishVerdict, number, { error: string }?]>([
        ['forbidden', FORBIDDEN_STATUS],
        ['unsupported', NOT_IMPLEMENTED_STATUS],
        ['gone', UNAUTHORIZED_STATUS],
        [{ ...LANDED, ok: false, published: false, reason: 'git push: rejected' }, BAD_GATEWAY_STATUS],
        [{ ...LANDED, ok: false, reason: 'git push: nope' }, BAD_GATEWAY_STATUS, { error: 'git push: nope' }],
        [
            { ...LANDED, ok: false, published: false, reason: 'git push: nope' },
            BAD_GATEWAY_STATUS,
            { error: 'git push: nope' },
        ],
        [
            { refused: 'a review is required and none has run' },
            CONFLICT_STATUS,
            { error: 'a review is required and none has run' },
        ],
        [
            { ...LANDED, ok: false, published: false, reason: 'moved on', stale: true },
            CONFLICT_STATUS,
            { error: 'moved on' },
        ],
    ])('maps %j to %i', async (verdict, status, body) => {
        const { server, port } = await opened({ publish: async () => verdict });
        const answer = await post(port, 'tok-p');
        expect(answer.status).toBe(status);
        if (body) await expect(answer.json()).resolves.toEqual(body);
        await server.close();
    });

    it('answers a nothing-to-publish as 200 unpublished', async () => {
        const nothing = await opened({
            publish: async () => ({ ...LANDED, published: false, prUrl: null, reason: 'nothing unpushed' }),
        });
        const answer = await post(nothing.port, 'tok-p');
        expect(answer.status).toBe(OK_STATUS);
        await expect(answer.json()).resolves.toMatchObject({ published: false, reason: 'nothing unpushed' });
        await nothing.server.close();
    });

    it('refuses an unknown token, a gate token and a closed one', async () => {
        const server = createGateServer({ host: '127.0.0.1', manager });
        server.register('gate-tok', { key: 'k', image: 'node:24', job: JOB, gates: [] });
        server.openControl('tok-p-supervisor', undefined, { publish: async () => LANDED });
        server.grantAgent('tok-p-supervisor', 'tok-p');
        const port = await server.listen();

        expect((await post(port, 'nope')).status).toBe(UNAUTHORIZED_STATUS);
        expect((await post(port, 'gate-tok')).status).toBe(UNAUTHORIZED_STATUS);
        // Closing the attempt closes both its tokens.
        server.closeControl('tok-p-supervisor');
        expect((await post(port, 'tok-p')).status).toBe(UNAUTHORIZED_STATUS);
        await server.close();
    });

    it('says unsupported when the attempt has no publisher, and only POST is the route', async () => {
        const { server, port } = await opened(undefined);
        expect((await post(port, 'tok-p')).status).toBe(NOT_IMPLEMENTED_STATUS);
        const get = await fetch(`http://127.0.0.1:${port}/publish`, { headers: { authorization: 'Bearer tok-p' } });
        expect(get.status).toBe(NOT_FOUND_STATUS);
        await server.close();
    });

    it('refuses a body past the limit', async () => {
        const { server, port } = await opened({ publish: async () => LANDED });
        expect((await post(port, 'tok-p', 'x'.repeat(4096))).status).toBe(PAYLOAD_TOO_LARGE_STATUS);
        await server.close();
    });

    it('runs one publish at a time per token: a second call is told, never queued', async () => {
        let release = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let calls = 0;
        const { server, port } = await opened({
            publish: async () => {
                calls += 1;
                await held;
                return LANDED;
            },
        });

        const first = post(port, 'tok-p');
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect((await post(port, 'tok-p')).status).toBe(CONFLICT_STATUS);
        release();
        expect((await first).status).toBe(OK_STATUS);
        expect((await post(port, 'tok-p')).status).toBe(OK_STATUS);
        expect(calls).toBe(2);
        await server.close();
    });
});

describe('the publish relay: what an attempt may publish', () => {
    interface Calls {
        asks: number;
        published: { token: string | undefined; options: PublishOptions | undefined }[];
    }
    const relayFor = (
        over: {
            job?: Partial<BoardJob>;
            publishGit?: LoopRuntime['runner']['publishGit'];
            token?: string | null;
            /** Tokens shifted per ask, then `token`. */
            tokens?: (string | null)[];
            /** Results shifted per publish, then LANDED. */
            publishes?: PublishResult[];
        } = {},
        onAsk: () => void = () => {}
    ) => {
        const calls: Calls = { asks: 0, published: [] };
        const tokens = [...(over.tokens ?? [])];
        const publishes = [...(over.publishes ?? [])];
        const state = newJobState();
        const runner = {
            publishGit:
                over.publishGit ??
                (async (_job: BoardJob, token?: string, options?: PublishOptions) => {
                    calls.published.push({ token, options });
                    return publishes.shift() ?? LANDED;
                }),
        };
        const rt = {
            runner,
            board: {
                githubCredential: async () => {
                    calls.asks += 1;
                    onAsk();
                    const queued = tokens.shift();
                    if (queued !== undefined) return queued;
                    return 'token' in over ? over.token : 'ghs_fresh';
                },
            },
            log: () => {},
            sleep: async () => {},
        } as unknown as LoopRuntime;
        return { relay: createPublishRelay(rt, { ...JOB, ...over.job }, state), state, calls };
    };

    it("publishes a draft with the board's minted token and remembers what landed", async () => {
        const { relay, state, calls } = relayFor();
        await expect(relay.publish()).resolves.toEqual(LANDED);
        expect(calls.published).toEqual([
            { token: 'ghs_fresh', options: { draft: true, recordPrOperation: expect.any(Function) } },
        ]);
        expect(state.draftPublication).toEqual(LANDED);
    });

    it('publishes without a token when the board issues none', async () => {
        const { relay, calls } = relayFor({ token: null });
        await relay.publish();
        expect(calls.published[0]?.token).toBeUndefined();
    });

    it('retries a draft whose token GitHub rejected, with a new token', async () => {
        const rejected = publishFailed(
            "git push: remote: Invalid username or token.\nfatal: Authentication failed for 'x'",
            'denied'
        );
        const { relay, state, calls } = relayFor({ tokens: ['ghs_a', 'ghs_b'], publishes: [rejected] });
        await expect(relay.publish()).resolves.toEqual(LANDED);
        expect(calls.asks).toBe(2);
        expect(calls.published.map((c) => c.token)).toEqual(['ghs_a', 'ghs_b']);
        for (const c of calls.published) {
            expect(c.options).toEqual({ draft: true, recordPrOperation: expect.any(Function) });
        }
        expect(state.draftPublication).toEqual(LANDED);
    });

    it('publishes nothing more once the attempt is gone between tries', async () => {
        const rejected = publishFailed('gh pr create: HTTP 502: Bad Gateway', 'transport');
        const gonePublish = async (_job: BoardJob, token?: string, options?: PublishOptions) => {
            calls.published.push({ token, options });
            recordEnding(state, 'lost');
            return rejected;
        };
        const { relay, state, calls } = relayFor({ publishGit: gonePublish });
        await expect(relay.publish()).resolves.toBe('gone');
        expect(calls.published).toHaveLength(1);
        expect(calls.asks).toBe(1);
    });

    it('is the board’s on a workflow task whose publication belongs to another step', async () => {
        const { relay, calls } = relayFor({ job: { publish: false } });
        await expect(relay.publish()).resolves.toBe('forbidden');
        expect(calls.asks).toBe(0);
        expect(calls.published).toEqual([]);
    });

    it.each(['stopped', 'lost', 'removed', 'draining', 'finished'] as const)(
        'publishes nothing once the attempt is %s',
        async (flag) => {
            const { relay, state, calls } = relayFor();
            if (flag === 'draining') state.draining = true;
            else if (flag === 'finished') transition(state, 'ended');
            else recordEnding(state, flag === 'stopped' ? 'stop' : flag);
            await expect(relay.publish()).resolves.toBe('gone');
            expect(calls.asks).toBe(0);
            expect(calls.published).toEqual([]);
        }
    );

    it('publishes nothing when the lease is lost while the credential is asked for', async () => {
        const holder: { state?: ReturnType<typeof newJobState> } = {};
        const made = relayFor({}, () => {
            if (holder.state) recordEnding(holder.state, 'lost');
        });
        holder.state = made.state;
        await expect(made.relay.publish()).resolves.toBe('gone');
        expect(made.calls.published).toEqual([]);
        expect(made.state.draftPublication).toBeNull();
    });

    it('answers a publish that throws as a failure, and keeps no draft', async () => {
        const { relay, state } = relayFor({
            publishGit: async () => {
                throw new Error('daemon gone');
            },
        });
        await expect(relay.publish()).resolves.toMatchObject({ ok: false, reason: 'the publish threw: daemon gone' });
        expect(state.draftPublication).toBeNull();
    });

    it('keeps no draft for a publish that landed nothing', async () => {
        const nothing: PublishResult = { ...LANDED, published: false, prUrl: null, reason: 'nothing unpushed' };
        const { relay, state } = relayFor({ publishGit: async () => nothing });
        await expect(relay.publish()).resolves.toEqual(nothing);
        expect(state.draftPublication).toBeNull();
    });

    describe('under a configured evidence policy', () => {
        it('refuses a draft when gates are required — an ad-hoc run is not evidence — before any credential is asked', async () => {
            const { relay, calls } = relayFor({ job: { policy: { gates: true } } });
            await expect(relay.publish()).resolves.toEqual({
                refused: 'declared gates are required but none ran over this work',
            });
            expect(calls.asks).toBe(0);
            expect(calls.published).toEqual([]);
        });

        it.each(['unavailable', 'missing', 'incomplete', 'rejected'] as const)(
            'refuses a required review that is %s',
            async (state) => {
                const { relay, calls } = relayFor({ job: { policy: { review: true }, review: { state } } });
                const verdict = await relay.publish();
                expect(verdict).toHaveProperty('refused');
                expect(calls.published).toEqual([]);
            }
        );

        it('binds the draft to the revision an approved review assessed', async () => {
            const { relay, calls } = relayFor({
                job: { policy: { review: true }, review: { state: 'approved', revision: 'r1' } },
            });
            await relay.publish();
            expect(calls.published).toEqual([
                {
                    token: 'ghs_fresh',
                    options: { draft: true, revision: 'r1', recordPrOperation: expect.any(Function) },
                },
            ]);
        });
    });
});

describe('a revision-bound publish across retries', () => {
    const REVISION = 'head-1:tree-1';
    const rejected = publishFailed(
        "git push: remote: Invalid username or token.\nfatal: Authentication failed for 'x'",
        'denied'
    );

    /** `publishWithRetry` over scripted probes (one per call, the last repeats) and publishes. */
    async function retrying(probes: TreeProbe[], publishes: PublishResult[]) {
        const revisions: (string | undefined)[] = [];
        const state = newJobState();
        const rt = {
            runner: {
                probeGateTree: async () => (probes.length > 1 ? probes.shift() : probes[0]),
                publishGit: async (_job: BoardJob, _token?: string, options?: PublishOptions) => {
                    revisions.push(options?.revision);
                    return publishes.shift() ?? LANDED;
                },
            },
            board: { githubCredential: async () => 'ghs' },
            log: () => {},
            sleep: async () => {},
        } as unknown as LoopRuntime;
        const result = await publishWithRetry(
            { rt, job: JOB, state },
            { what: 'the publish', options: { revision: REVISION } },
            () => false
        );
        return { result, revisions };
    }
    const probe = (fingerprint: string | null, content: string | null): TreeProbe => ({
        fingerprint,
        content,
        mutatedSince: null,
    });

    it('rebinds to the fingerprint its own commit moved when the content is the one assessed', async () => {
        const r = await retrying([probe(REVISION, 'c1'), probe('head-2:tree-1', 'c1')], [rejected, LANDED]);
        expect(r.result).toEqual(LANDED);
        expect(r.revisions).toEqual([REVISION, 'head-2:tree-1']);
    });

    it('keeps the original binding when the content changed between tries, so the retry is refused as stale', async () => {
        const r = await retrying([probe(REVISION, 'c1'), probe('head-2:tree-2', 'c2')], [rejected, LANDED]);
        expect(r.revisions).toEqual([REVISION, REVISION]);
    });

    it('keeps the original binding when a probe is inconclusive', async () => {
        const r = await retrying([probe(REVISION, 'c1'), probe(null, null)], [rejected, LANDED]);
        expect(r.revisions).toEqual([REVISION, REVISION]);
    });

    it('never probes an unbound publish', async () => {
        let probed = 0;
        const rt = {
            runner: {
                probeGateTree: async () => {
                    probed += 1;
                    return probe(null, null);
                },
                publishGit: async () => LANDED,
            },
            board: { githubCredential: async () => 'ghs' },
            log: () => {},
            sleep: async () => {},
        } as unknown as LoopRuntime;
        await publishWithRetry({ rt, job: JOB, state: newJobState() }, { what: 'x', options: undefined }, () => false);
        expect(probed).toBe(0);
    });
});

describe('the control server: POST /gate/run', () => {
    const KEY = 'root/repo';
    const gates: GateClaim['gates'] = [
        { name: 'verify', command: 'npm test', filter: true },
        { name: 'slow', command: 'npm run slow', timeoutMinutes: 11 },
    ];
    const SUPERVISOR = 'tok-g-supervisor';
    const AGENT = 'tok-g-agent';
    const EXPORTER = 'tok-g-exporter';
    const SERVICE_UNAVAILABLE_STATUS = 503;
    const UNPROCESSABLE_STATUS = 422;

    const post = (port: number, token: string, body: unknown = { gate: 'verify' }, signal?: AbortSignal) =>
        fetch(`http://127.0.0.1:${port}/gate/run`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
            ...(signal ? { signal } : {}),
        });

    /** A control channel with the agent and exporter tokens granted; `register` also files the gate claim and opens the door. */
    async function opened(runGate: (...args: unknown[]) => Promise<{ exitCode: number; output: string }>) {
        const server = createGateServer({ host: '127.0.0.1', manager: { acquire: async () => {}, runGate } });
        server.openControl(SUPERVISOR);
        server.grantAgent(SUPERVISOR, AGENT);
        server.grantExporter(SUPERVISOR, EXPORTER);
        const gateToken = 'tok-g-gate';
        const register = () => {
            server.register(gateToken, { key: KEY, image: 'node:24', job: JOB, gates });
            server.attachGateRun(SUPERVISOR, gateToken);
        };
        return { server, port: await server.listen(), gateToken, register };
    }

    const passes = async () => ({ exitCode: 0, output: 'all green' });

    it('answers a retryable 503 until the gate claim is attached: never "no gates", never a run', async () => {
        let ran = 0;
        const { server, port } = await opened(async () => {
            ran += 1;
            return { exitCode: 0, output: '' };
        });
        const answer = await post(port, AGENT);
        expect(answer.status).toBe(SERVICE_UNAVAILABLE_STATUS);
        await expect(answer.json()).resolves.toMatchObject({ retryable: true });
        expect(ran).toBe(0);
        await server.close();
    });

    it('runs the declared gate of the attached claim under the agent token', async () => {
        const { server, port, register } = await opened(passes);
        register();
        const answer = await post(port, AGENT);
        expect(answer.status).toBe(OK_STATUS);
        await expect(answer.json()).resolves.toMatchObject({ exitCode: 0, output: 'all green' });
        await server.close();
    });

    it('answers 404 "no gates" for a job that declares none', async () => {
        const { server, port } = await opened(passes);
        server.attachGateRun(SUPERVISOR, null);
        const answer = await post(port, AGENT);
        expect(answer.status).toBe(NOT_FOUND_STATUS);
        await expect(answer.json()).resolves.toEqual({ error: 'no gates' });
        await server.close();
    });

    it('opens the route to the agent token alone: the supervisor and exporter tokens are 403, an unknown one 401', async () => {
        const { server, port, register } = await opened(passes);
        register();
        expect((await post(port, SUPERVISOR)).status).toBe(FORBIDDEN_STATUS);
        expect((await post(port, EXPORTER)).status).toBe(FORBIDDEN_STATUS);
        expect((await post(port, 'tok-g-unknown')).status).toBe(UNAUTHORIZED_STATUS);
        await server.close();
    });

    it('is closed again once the gate claim is unregistered: 503, not a run', async () => {
        let ran = 0;
        const { server, port, gateToken, register } = await opened(async () => {
            ran += 1;
            return { exitCode: 0, output: '' };
        });
        register();
        server.unregister(gateToken);
        const answer = await post(port, AGENT);
        expect(answer.status).toBe(SERVICE_UNAVAILABLE_STATUS);
        expect(ran).toBe(0);
        await server.close();
    });

    it('stops admitting runs once the token is quiesced, as the direct route does', async () => {
        const { server, port, gateToken, register } = await opened(passes);
        register();
        await server.quiesce(gateToken);
        const answer = await post(port, AGENT);
        expect(answer.status).toBe(SERVICE_UNAVAILABLE_STATUS);
        await expect(answer.json()).resolves.toMatchObject({ retryable: true });
        await server.close();
    });

    it('keeps the ad-hoc rules: an undeclared gate is 404, a filter the gate does not take and a gate too long to wait for are 422', async () => {
        const { server, port, register } = await opened(passes);
        register();
        expect((await post(port, AGENT, { gate: 'missing' })).status).toBe(NOT_FOUND_STATUS);
        expect((await post(port, AGENT, { gate: 'slow' })).status).toBe(UNPROCESSABLE_STATUS);
        expect((await post(port, AGENT, { gate: 'verify', filter: 'a-test' })).status).toBe(OK_STATUS);
        await server.close();
    });

    it('cancels the run when the agent hangs up on it', async () => {
        let aborted: Promise<void> = Promise.resolve();
        let started: () => void = () => {};
        const running = new Promise<void>((resolve) => (started = resolve));
        const { server, port, register } = await opened(async (...args) => {
            const { signal } = args[3] as { signal: AbortSignal };
            aborted = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
            started();
            await aborted;
            return { exitCode: 130, output: 'killed' };
        });
        register();
        const hangUp = new AbortController();
        const asked = post(port, AGENT, { gate: 'verify' }, hangUp.signal).catch(() => undefined);
        await running;
        hangUp.abort();
        await asked;
        await aborted;
        await server.close();
    });
});
