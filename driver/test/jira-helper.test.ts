import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT as ROOT } from './fixtures/repo-files.js';

/**
 * The runner's Jira helper (docs/connections.md): the real helper against a fake board (the connection list, the
 * credential broker, the operation receipts as a state machine with the board's transition rules) and a fake Jira
 * (a node http server on 127.0.0.1). Only the two network edges are fake; the broker is injected except where the
 * real library's renewal is the point.
 */

const HELPER = join(ROOT, 'docker/skills/jira/jira.cjs');
const BROKER = join(ROOT, 'docker/claude-executor/credential-broker.cjs');
const require_ = createRequire(import.meta.url);

type Json = Record<string, unknown>;
interface Result {
    ok: boolean;
    token?: string;
    expiresAt?: string | null;
    scopes?: string[];
    resource?: unknown;
    reason?: string;
}
type Asked =
    | { kind: 'answer'; answer: 'bound' | 'unavailable' | 'waiting' }
    | { kind: 'absent' | 'refused' | 'inconclusive' };
interface Deps {
    env: Record<string, string | undefined>;
    now: () => number;
    fetch: typeof fetch;
    sleep: (ms: number) => Promise<void>;
    pair: (env: Record<string, string | undefined>) => Promise<{ jobId: string; leaseToken: string }>;
    credential: (id: string, remainingMs: number) => Promise<Result>;
    ask: (provider: string, remainingMs: number, target?: string) => Promise<Asked>;
    eraseCredential: (id: string) => void;
    readFile: (path: string) => string;
    stdout: (text: string) => void;
    stderr: (text: string) => void;
    deadlineMs: number;
}
const helper = require_(HELPER) as {
    run: (argv: string[], deps: Deps) => Promise<number>;
};

const JOB = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const CONN_A = '33333333-3333-4333-8333-333333333333';
const CONN_B = '44444444-4444-4444-8444-444444444444';
const CLOUD = 'cloud-a';
const CLOUD_B = 'cloud-b';
const ME = 'stub-account-a';
const TOKEN = 'tok-SECRET-value';
const WRITE_SCOPES = ['read:jira-work', 'read:jira-user', 'write:jira-work'];
const READ_SCOPES = ['read:jira-work', 'read:jira-user'];
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
        let text = '';
        req.on('data', (chunk) => {
            text += chunk;
        });
        req.on('end', () => resolve(text));
    });
const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
};
const listen = (server: Server): Promise<string> =>
    new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
    });

type PostMode = 'ok' | 'drop-after-create' | 'drop-before-create' | 'forbidden' | 'bad-request';

/** A fake Jira Cloud: per-call records, a comment store with properties, scripted faults. */
function fakeJira() {
    const state = {
        calls: [] as { method: string; url: string; auth: string; body: Json | null }[],
        posts: 0,
        comments: [] as { id: string; author: { accountId: string }; created: string; body: unknown }[],
        properties: new Map<string, unknown>(),
        postMode: 'ok' as PostMode,
        issueStatus: 200,
        stall: false,
        rejectTokens: new Set<string>(),
        myselfStatus: 200,
        searchPages: [] as { issues: unknown[]; nextPageToken?: string }[],
        nextId: 100,
    };
    const server = createServer(async (req, res) => {
        const raw = await readBody(req);
        const url = req.url ?? '';
        const auth = String(req.headers.authorization ?? '');
        state.calls.push({ method: req.method ?? '', url, auth, body: raw ? (JSON.parse(raw) as Json) : null });
        if (state.stall) return; // never answers
        if (state.rejectTokens.has(auth.replace('Bearer ', ''))) return send(res, 401, { message: 'no' });
        const path = new URL(url, 'http://x').pathname;
        const prefix = `/ex/jira/${CLOUD}/rest/api/3`;
        if (path === `${prefix}/myself`) {
            return state.myselfStatus === 200
                ? send(res, 200, { accountId: ME })
                : send(res, state.myselfStatus, { message: 'x' });
        }
        if (/\/issue\/[A-Z]+-\d+$/.test(path)) {
            return send(res, state.issueStatus, { key: path.split('/').pop(), fields: { summary: 'S' } });
        }
        if (path === `${prefix}/search/jql`) {
            const token = new URL(url, 'http://x').searchParams.get('nextPageToken');
            const index = token === null ? 0 : Number(token);
            return send(res, 200, state.searchPages[index] ?? { issues: [] });
        }
        if (/\/issue\/[A-Z]+-\d+\/comment$/.test(path) && req.method === 'GET') {
            const params = new URL(url, 'http://x').searchParams;
            const startAt = Number(params.get('startAt'));
            const max = Number(params.get('maxResults'));
            const ordered = params.get('orderBy') === '-created' ? [...state.comments].reverse() : state.comments;
            return send(res, 200, {
                comments: ordered.slice(startAt, startAt + max),
                startAt,
                maxResults: max,
                total: ordered.length,
            });
        }
        if (/\/issue\/[A-Z]+-\d+\/comment$/.test(path) && req.method === 'POST') {
            state.posts++;
            if (state.postMode === 'forbidden') return send(res, 403, { message: 'nope' });
            if (state.postMode === 'bad-request') return send(res, 400, { message: 'bad' });
            if (state.postMode === 'drop-before-create') return void req.socket.destroy();
            const id = String(state.nextId++);
            const posted = JSON.parse(raw) as { body: unknown; properties?: { key: string; value: unknown }[] };
            state.comments.push({
                id,
                author: { accountId: ME },
                created: new Date().toISOString(),
                body: posted.body,
            });
            for (const property of posted.properties ?? [])
                state.properties.set(`${id}/${property.key}`, property.value);
            if (state.postMode === 'drop-after-create') return void req.socket.destroy();
            return send(res, 201, { id, author: { accountId: ME }, created: new Date().toISOString() });
        }
        const prop = /\/comment\/(\d+)\/properties\/([\w-]+)$/.exec(path);
        if (prop) {
            const value = state.properties.get(`${prop[1]}/${prop[2]}`);
            return value === undefined ? send(res, 404, { message: 'none' }) : send(res, 200, { key: prop[2], value });
        }
        return send(res, 404, { message: 'unknown' });
    });
    return { state, server };
}

type Status = 'started' | 'dispatched' | 'succeeded' | 'failed' | 'unknown';
interface Receipt {
    id: string;
    status: Status;
    result: { commentId: string } | null;
    dispatchedAt: string | null;
    key: string;
    fingerprint: string;
    connectionId: string;
}
const ALLOWED: Record<string, Status[]> = {
    started: ['dispatched', 'failed'],
    dispatched: ['succeeded', 'failed', 'unknown'],
    unknown: ['succeeded'],
};

/** A fake board: connection list, operation receipts with the slice-3 transition rules, scripted faults. */
function fakeBoard(getConnections: () => unknown) {
    const state = {
        receipts: new Map<string, Receipt>(),
        listFailures: 0,
        listAlwaysFails: false,
        beginAlwaysFails: false,
        conflictOnDispatch: false,
        moves: [] as { from: Status[]; to: Status }[],
        brokerAsks: 0,
        issued: 0,
        brokerBase: Date.now(),
    };
    const publicOf = ({ id, status, result, dispatchedAt }: Receipt) => ({ id, status, result, dispatchedAt });
    const server = createServer(async (req, res) => {
        const raw = await readBody(req);
        const path = new URL(req.url ?? '', 'http://x').pathname;
        if (req.headers['x-factory-job-id'] !== JOB || req.headers['x-factory-job-lease-token'] !== LEASE) {
            return send(res, 401, { error: 'pair' });
        }
        if (req.method === 'GET' && path === `/api/jobs/${JOB}/credentials/connections`) {
            if (state.listAlwaysFails || state.listFailures > 0) {
                state.listFailures--;
                return send(res, 503, { error: 'later' });
            }
            return send(res, 200, { connections: getConnections() });
        }
        if (req.method === 'POST' && path.startsWith(`/api/jobs/${JOB}/credentials/connections/`)) {
            state.brokerAsks++;
            return send(res, 200, {
                token: TOKEN,
                expiresAt: new Date(state.brokerBase + 3600_000).toISOString(),
                scopes: WRITE_SCOPES,
                resource: CLOUD,
            });
        }
        if (req.method === 'POST' && path === `/api/jobs/${JOB}/operations`) {
            if (state.beginAlwaysFails) return send(res, 503, { error: 'later' });
            const body = JSON.parse(raw) as { connectionId: string; key: string; fingerprint: string };
            const existing = state.receipts.get(body.key);
            if (existing) {
                if (existing.fingerprint !== body.fingerprint || existing.connectionId !== body.connectionId) {
                    return send(res, 409, { code: 'OPERATION_KEY_REUSED' });
                }
                return send(res, 200, { receipt: publicOf(existing), created: false });
            }
            const made: Receipt = {
                id: `55555555-5555-4555-8555-${String(state.issued++).padStart(12, '0')}`,
                status: 'started',
                result: null,
                dispatchedAt: null,
                ...body,
            };
            state.receipts.set(body.key, made);
            return send(res, 200, { receipt: publicOf(made), created: true });
        }
        const move = /\/operations\/([0-9a-f-]+)$/.exec(path);
        if (req.method === 'PUT' && move) {
            const body = JSON.parse(raw) as { from: Status[]; to: Status; result?: { commentId: string } };
            state.moves.push({ from: body.from, to: body.to });
            const receipt = [...state.receipts.values()].find((r) => r.id === move[1]);
            if (!receipt) return send(res, 404, { error: 'none' });
            const refuse = state.conflictOnDispatch && body.to === 'dispatched';
            if (refuse || !body.from.includes(receipt.status) || !ALLOWED[receipt.status]?.includes(body.to)) {
                return send(res, 409, { code: 'OPERATION_CONFLICT', receipt: publicOf(receipt) });
            }
            receipt.status = body.to;
            if (body.to === 'dispatched') receipt.dispatchedAt = new Date().toISOString();
            if (body.result) receipt.result = body.result;
            return send(res, 200, { receipt: publicOf(receipt) });
        }
        return send(res, 404, { error: 'unknown' });
    });
    return { state, server };
}

interface Scenario {
    jira: ReturnType<typeof fakeJira>['state'];
    board: ReturnType<typeof fakeBoard>['state'];
    jiraUrl: string;
    boardUrl: string;
    ask: { count: number; scopes: string[]; erased: number };
    /** The providers the helper asked the board's runtime requirement for, in order. */
    asks: string[];
    /** The target each ask carried (undefined when it carried none). */
    askTargets: (string | undefined)[];
    run: (argv: string[], overrides?: Partial<Deps>) => Promise<{ code: number; out: string; err: string }>;
    receipts: () => Receipt[];
}

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(() => {
    for (const server of servers.splice(0)) server.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function scenario(
    options: {
        scopes?: string[];
        connections?: 'one' | 'two' | 'none' | 'other-provider' | 'bound-after-ask';
        deadlineMs?: number;
        /** What each runtime ask answers, in order; the last repeats. No proxy (`absent`) when empty. */
        asked?: Asked[];
        /** The broker's refusal for the first credential asks, before it issues. */
        brokerRefusals?: number;
    } = {}
): Promise<Scenario> {
    const jira = fakeJira();
    const jiraUrl = await listen(jira.server);
    const entry = (id: string, cloud: string, site: string, provider = 'jira') => ({
        id,
        provider,
        site,
        resource: cloud,
        access: 'write',
        apiBase: `${jiraUrl}/ex/jira/${cloud}/rest/api/3`,
    });
    const shape = options.connections ?? 'one';
    const asks: string[] = [];
    const askTargets: (string | undefined)[] = [];
    const connections = () =>
        shape === 'none' || (shape === 'bound-after-ask' && asks.length === 0)
            ? []
            : shape === 'two'
              ? [entry(CONN_A, CLOUD, 'a.example.net'), entry(CONN_B, CLOUD_B, 'b.example.net')]
              : shape === 'other-provider'
                ? [entry(CONN_A, CLOUD, 'a.example.net', 'github')]
                : [entry(CONN_A, CLOUD, 'a.example.net')];
    const board = fakeBoard(connections);
    const boardUrl = await listen(board.server);
    servers.push(jira.server, board.server);
    const ask = { count: 0, scopes: options.scopes ?? WRITE_SCOPES, erased: 0 };
    const run: Scenario['run'] = async (argv, overrides = {}) => {
        let out = '';
        let err = '';
        const deps: Deps = {
            env: { FACTORY_STATS_URL: boardUrl, RUNNER_JOB_ID: JOB, RUNNER_LEASE_TOKEN: LEASE },
            now: Date.now,
            fetch: globalThis.fetch,
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            pair: async () => ({ jobId: JOB, leaseToken: LEASE }),
            credential: async (_id, _remaining) => {
                ask.count++;
                if (ask.count <= (options.brokerRefusals ?? 0)) return { ok: false, reason: 'integration_required' };
                return { ok: true, token: TOKEN, expiresAt: null, scopes: ask.scopes, resource: CLOUD };
            },
            ask: async (provider, _remainingMs, target) => {
                asks.push(provider);
                askTargets.push(target);
                const scripted = options.asked ?? [{ kind: 'absent' }];
                return scripted[Math.min(asks.length - 1, scripted.length - 1)] as Asked;
            },
            eraseCredential: () => {
                ask.erased++;
            },
            readFile: () => '',
            stdout: (text) => {
                out += text;
            },
            stderr: (text) => {
                err += text;
            },
            deadlineMs: options.deadlineMs ?? 3000,
            ...overrides,
        };
        const code = await helper.run(argv, deps);
        return { code, out, err };
    };
    return {
        jira: jira.state,
        board: board.state,
        jiraUrl,
        boardUrl,
        ask,
        asks,
        askTargets,
        run,
        receipts: () => [...board.state.receipts.values()],
    };
}

const BODY = 'Looks good.\nSecond line.';
const comment = (...rest: string[]) => ['comment', 'ABC-1', '--body', BODY, ...rest];
const DEFAULT_KEY = sha(`${CONN_A}|ABC-1|${BODY}`);
const jiraPath = (suffix: string) => `/ex/jira/${CLOUD}/rest/api/3${suffix}`;

describe('reading', () => {
    it('60: issue prints the issue JSON, dispatches the real URL, and never the token', async () => {
        const s = await scenario();
        const { code, out, err } = await s.run(['issue', 'ABC-1', '--fields', 'summary,status']);
        expect(code).toBe(0);
        expect(JSON.parse(out)).toMatchObject({ key: 'ABC-1' });
        expect(s.jira.calls.map((c) => c.url)).toEqual([jiraPath('/issue/ABC-1?fields=summary%2Cstatus')]);
        expect(s.jira.calls[0]?.auth).toBe(`Bearer ${TOKEN}`);
        expect(out + err).not.toContain(TOKEN);
    });

    it('61: search follows nextPageToken; comments page by startAt', async () => {
        const s = await scenario();
        s.jira.searchPages = [
            { issues: [{ key: 'A-1' }], nextPageToken: '1' },
            { issues: [{ key: 'A-2' }], nextPageToken: '2' },
            { issues: [{ key: 'A-3' }], isLast: true } as never,
        ];
        const found = await s.run(['search', 'project = ABC']);
        expect(found.code).toBe(0);
        expect((JSON.parse(found.out) as { issues: { key: string }[] }).issues.map((i) => i.key)).toEqual([
            'A-1',
            'A-2',
            'A-3',
        ]);
        const tokens = s.jira.calls.map((c) => new URL(c.url, 'http://x').searchParams.get('nextPageToken'));
        expect(tokens).toEqual([null, '1', '2']);
        expect(s.jira.calls.every((c) => c.url.startsWith(jiraPath('/search/jql?')))).toBe(true);

        for (let i = 0; i < 250; i++) {
            s.jira.comments.push({
                id: String(i),
                author: { accountId: ME },
                created: new Date().toISOString(),
                body: i,
            });
        }
        s.jira.calls.length = 0;
        const listed = await s.run(['comments', 'ABC-1']);
        expect(listed.code).toBe(0);
        expect((JSON.parse(listed.out) as { comments: unknown[] }).comments).toHaveLength(250);
        expect(s.jira.calls.map((c) => new URL(c.url, 'http://x').searchParams.get('startAt'))).toEqual([
            '0',
            '100',
            '200',
        ]);
        expect(s.jira.calls[0]?.url.startsWith(jiraPath('/issue/ABC-1/comment?'))).toBe(true);
    });
});

describe('finding the connection', () => {
    it('62: a confirmed empty list is exit 3; a failing list is retried, then exit 1 at the deadline, never 3', async () => {
        const none = await scenario({ connections: 'none' });
        expect((await none.run(['issue', 'ABC-1'])).code).toBe(3);
        const other = await scenario({ connections: 'other-provider' });
        expect((await other.run(['issue', 'ABC-1'])).code).toBe(3);

        const flaky = await scenario();
        flaky.board.listFailures = 2;
        expect((await flaky.run(['issue', 'ABC-1'])).code).toBe(0);

        const down = await scenario({ deadlineMs: 1200 });
        down.board.listAlwaysFails = true;
        const started = Date.now();
        const result = await down.run(['issue', 'ABC-1']);
        expect(result.code).toBe(1);
        expect(Date.now() - started).toBeLessThan(4000);
        expect(down.jira.calls).toHaveLength(0);
    });

    it('63: two bindings without --site is exit 1 naming --site; --site picks one', async () => {
        const s = await scenario({ connections: 'two' });
        const ambiguous = await s.run(['issue', 'ABC-1']);
        expect(ambiguous.code).toBe(1);
        expect(ambiguous.err).toContain('--site');
        expect(s.jira.calls).toHaveLength(0);
        const picked = await s.run(['issue', 'ABC-1', '--site', 'a.example.net']);
        expect(picked.code).toBe(0);
        expect(s.jira.calls[0]?.url).toBe(jiraPath('/issue/ABC-1'));
    });
});

describe('the runtime connection ask', () => {
    const outcomeOf = (out: string) => JSON.parse(out.trim().split('\n').pop() ?? '{}') as Json;

    it('bound continues the same call after re-reading the list', async () => {
        const s = await scenario({ connections: 'bound-after-ask', asked: [{ kind: 'answer', answer: 'bound' }] });
        const result = await s.run(['issue', 'ABC-1']);
        expect(result.code).toBe(0);
        expect(s.asks).toEqual(['jira']);
        expect(s.askTargets).toEqual([undefined]);
        expect(s.jira.calls[0]?.url).toBe(jiraPath('/issue/ABC-1'));
    });

    it('unavailable exits 3: continue without Jira and say so', async () => {
        const s = await scenario({ connections: 'none', asked: [{ kind: 'answer', answer: 'unavailable' }] });
        const result = await s.run(['issue', 'ABC-1']);
        expect(result.code).toBe(3);
        expect(outcomeOf(result.out)).toEqual({ outcome: 'integration_required', reason: 'connection_unavailable' });
        expect(result.err).toContain('without Jira');
        expect(s.jira.calls).toHaveLength(0);
    });

    it('waiting exits 3 waiting_for_connection: the task pauses here and resumes in this session', async () => {
        const s = await scenario({ connections: 'none', asked: [{ kind: 'answer', answer: 'waiting' }] });
        const result = await s.run(['issue', 'ABC-1']);
        expect(result.code).toBe(3);
        expect(outcomeOf(result.out)).toEqual({ outcome: 'integration_required', reason: 'waiting_for_connection' });
        expect(result.err).toContain('resumes in this session');
        expect(s.asks).toEqual(['jira']);
    });

    it('an inconclusive ask is retried inside the deadline, then ends deadline exit 1, never unavailable or waiting', async () => {
        const s = await scenario({ connections: 'none', deadlineMs: 1200, asked: [{ kind: 'inconclusive' }] });
        const started = Date.now();
        const result = await s.run(['issue', 'ABC-1']);
        expect(result.code).toBe(1);
        expect(outcomeOf(result.out)).toEqual({ outcome: 'unavailable', reason: 'deadline' });
        expect(s.asks.length).toBeGreaterThan(1);
        expect(Date.now() - started).toBeLessThan(4000);
    });

    it('an inconclusive ask that then answers is that answer', async () => {
        const s = await scenario({
            connections: 'none',
            asked: [{ kind: 'inconclusive' }, { kind: 'answer', answer: 'waiting' }],
        });
        const result = await s.run(['issue', 'ABC-1']);
        expect(result.code).toBe(3);
        expect(outcomeOf(result.out).reason).toBe('waiting_for_connection');
        expect(s.asks).toEqual(['jira', 'jira']);
    });

    it('a refused ask stops board_refused', async () => {
        const s = await scenario({ connections: 'none', asked: [{ kind: 'refused' }] });
        const result = await s.run(['issue', 'ABC-1']);
        expect(result.code).toBe(1);
        expect(outcomeOf(result.out)).toEqual({ outcome: 'refused', reason: 'board_refused' });
        expect(s.asks).toEqual(['jira']);
    });

    it("no proxy at all is today's exit 3 no_connection", async () => {
        const s = await scenario({ connections: 'none', asked: [{ kind: 'absent' }] });
        const result = await s.run(['issue', 'ABC-1']);
        expect(result.code).toBe(3);
        expect(outcomeOf(result.out).reason).toBe('no_connection');
    });

    it('asks when the bound Jira connections do not match --site, and never when one matches', async () => {
        const s = await scenario({ connections: 'two', asked: [{ kind: 'answer', answer: 'waiting' }] });
        const other = await s.run(['issue', 'ABC-1', '--site', 'c.example.net']);
        expect(other.code).toBe(3);
        expect(outcomeOf(other.out).reason).toBe('waiting_for_connection');
        expect(s.asks).toEqual(['jira']);
        expect(s.askTargets).toEqual(['c.example.net']);
        expect((await s.run(['issue', 'ABC-1', '--site', 'a.example.net'])).code).toBe(0);
        expect(s.asks).toEqual(['jira']);
    });

    it('never asks for insufficient scopes', async () => {
        const s = await scenario({ scopes: READ_SCOPES, asked: [{ kind: 'answer', answer: 'waiting' }] });
        const result = await s.run(comment());
        expect(result.code).toBe(3);
        expect(outcomeOf(result.out).reason).toBe('insufficient_scopes');
        expect(s.asks).toEqual([]);
    });

    it('asks when the broker says the connection needs the user, and continues once bound', async () => {
        const s = await scenario({ brokerRefusals: 1, asked: [{ kind: 'answer', answer: 'bound' }] });
        const result = await s.run(['issue', 'ABC-1']);
        expect(result.code).toBe(0);
        expect(s.asks).toEqual(['jira']);
    });

    it("pauses on the broker's reconnect when the ask says waiting", async () => {
        const s = await scenario({ brokerRefusals: 1, asked: [{ kind: 'answer', answer: 'waiting' }] });
        const result = await s.run(['issue', 'ABC-1']);
        expect(result.code).toBe(3);
        expect(outcomeOf(result.out).reason).toBe('waiting_for_connection');
        expect(s.jira.calls).toHaveLength(0);
    });
});

describe('add-comment', () => {
    it('64: no write scope is exit 3 insufficient_scopes, no receipt, no POST', async () => {
        const s = await scenario({ scopes: READ_SCOPES });
        const { code, out } = await s.run(comment());
        expect(code).toBe(3);
        expect(JSON.parse(out)).toMatchObject({
            outcome: 'integration_required',
            reason: 'insufficient_scopes',
            missingScopes: ['write:jira-work'],
        });
        expect(s.jira.posts).toBe(0);
        expect(s.receipts()).toHaveLength(0);
    });

    it('65: begin, dispatched, POST with the bellows-operation property, succeeded; a rerun posts nothing', async () => {
        const s = await scenario();
        const first = await s.run(comment());
        expect(first.code).toBe(0);
        expect(JSON.parse(first.out)).toEqual({ commentId: '100' });
        const post = s.jira.calls.find((c) => c.method === 'POST');
        expect(post?.url).toBe(jiraPath('/issue/ABC-1/comment'));
        expect(post?.body).toMatchObject({
            properties: [{ key: 'bellows-operation', value: { receipt: s.receipts()[0]?.id } }],
        });
        expect(s.board.moves.map((m) => m.to)).toEqual(['dispatched', 'succeeded']);
        expect(s.receipts()[0]).toMatchObject({ status: 'succeeded', result: { commentId: '100' } });
        const again = await s.run(comment());
        expect(again.code).toBe(0);
        expect(JSON.parse(again.out)).toEqual({ commentId: '100' });
        expect(s.jira.posts).toBe(1);
    });

    it('66: a response lost after Jira created the comment reconciles through the property', async () => {
        const s = await scenario();
        s.jira.postMode = 'drop-after-create';
        const { code, out } = await s.run(comment());
        expect(code).toBe(0);
        expect(JSON.parse(out)).toEqual({ commentId: '100' });
        expect(s.jira.posts).toBe(1);
        expect(s.receipts()[0]?.status).toBe('succeeded');
    });

    it('67: a lost response where Jira did not create it is exit 4 unknown, and a rerun never posts again', async () => {
        const s = await scenario();
        s.jira.postMode = 'drop-before-create';
        const first = await s.run(comment());
        expect(first.code).toBe(4);
        expect(JSON.parse(first.out)).toMatchObject({ outcome: 'outcome_unknown' });
        expect(s.receipts()[0]?.status).toBe('unknown');
        s.jira.postMode = 'ok';
        const again = await s.run(comment());
        expect(again.code).toBe(4);
        expect(s.receipts()[0]?.status).toBe('unknown');
        expect(s.jira.posts).toBe(1);
    });

    it('67b: a same-account same-body comment without the property is no evidence', async () => {
        const s = await scenario();
        await s.run(comment()); // creates the receipt and a real comment
        const receipt = s.receipts()[0] as Receipt;
        s.jira.properties.clear();
        receipt.status = 'dispatched';
        receipt.result = null;
        s.jira.calls.length = 0;
        const { code } = await s.run(comment());
        expect(code).toBe(4);
        expect(receipt.status).toBe('unknown');
        expect(s.jira.posts).toBe(1);
    });

    it('67c: a comment carrying the property of another operation is not evidence', async () => {
        const s = await scenario();
        s.jira.postMode = 'drop-before-create';
        s.jira.comments.push({ id: '7', author: { accountId: ME }, created: new Date().toISOString(), body: 'x' });
        s.jira.properties.set('7/bellows-operation', { receipt: '55555555-5555-4555-8555-999999999999' });
        const { code } = await s.run(comment());
        expect(code).toBe(4);
        expect(s.receipts()[0]?.status).toBe('unknown');
    });

    it("67d: another task root's receipt for the same connection, issue and body is not evidence", async () => {
        const s = await scenario();
        await s.run(comment()); // the first root's receipt R1 and its real comment, carrying R1
        const first = s.receipts()[0] as Receipt;
        s.board.receipts.clear(); // a second root: same logical key, a new durable receipt
        s.jira.postMode = 'drop-before-create';
        const { code, out } = await s.run(comment());
        expect(code).toBe(4);
        expect(JSON.parse(out)).toMatchObject({ outcome: 'outcome_unknown' });
        const second = s.receipts()[0] as Receipt;
        expect(second.id).not.toBe(first.id);
        expect(second.status).toBe('unknown');
        expect(second.result).toBeNull();
        expect(s.jira.posts).toBe(2);
    });

    it('68: a reconcile read that fails is unknown, never a POST', async () => {
        const s = await scenario();
        s.jira.postMode = 'drop-before-create';
        s.jira.myselfStatus = 500;
        const { code } = await s.run(comment());
        expect(code).toBe(4);
        expect(s.receipts()[0]?.status).toBe('unknown');
        expect(s.jira.posts).toBe(1);
    });

    it('69: a begin that fails until the deadline is exit 1 and no POST', async () => {
        const s = await scenario({ deadlineMs: 1200 });
        s.board.beginAlwaysFails = true;
        const { code } = await s.run(comment());
        expect(code).toBe(1);
        expect(s.jira.posts).toBe(0);
    });

    it('70: losing the started to dispatched move to another invocation is exit 4, no POST', async () => {
        const s = await scenario();
        s.board.conflictOnDispatch = true;
        const { code } = await s.run(comment());
        expect(code).toBe(4);
        expect(s.jira.posts).toBe(0);
    });

    it('70b: the same KEY and body is one receipt; --key K is a second', async () => {
        const s = await scenario();
        await s.run(comment());
        await s.run(comment());
        expect(s.receipts()).toHaveLength(1);
        expect(s.receipts()[0]?.key).toBe(DEFAULT_KEY);
        await s.run(comment('--key', 'retry-1'));
        expect(s.receipts().map((r) => r.key)).toEqual([DEFAULT_KEY, 'retry-1']);
        expect(s.receipts()[1]?.fingerprint).toBe(sha(`ABC-1|${BODY}`));
        expect(s.jira.posts).toBe(2);
    });

    it('a 403 on the POST records failed and is exit 1; the failed key is not retried silently', async () => {
        const s = await scenario();
        s.jira.postMode = 'forbidden';
        const first = await s.run(comment());
        expect(first.code).toBe(1);
        expect(JSON.parse(first.out)).toMatchObject({ reason: 'provider-denied' });
        expect(s.receipts()[0]?.status).toBe('failed');
        s.jira.postMode = 'ok';
        const again = await s.run(comment());
        expect(again.code).toBe(1);
        expect(again.err).toContain('--key');
        expect(s.jira.posts).toBe(1);
    });

    it('--body-file: a missing file and an unreadable one both stop before any receipt', async () => {
        const s = await scenario();
        const missing = await s.run(['comment', 'ABC-1', '--body-file', '/nope'], {
            readFile: () => {
                throw Object.assign(new Error('x'), { code: 'ENOENT' });
            },
        });
        expect(missing.code).toBe(1);
        expect(missing.err).toContain('no such file');
        const denied = await s.run(['comment', 'ABC-1', '--body-file', '/nope'], {
            readFile: () => {
                throw Object.assign(new Error('x'), { code: 'EACCES' });
            },
        });
        expect(denied.code).toBe(1);
        expect(denied.err).toContain('unreadable (EACCES)');
        expect(s.receipts()).toHaveLength(0);
        expect(s.jira.posts).toBe(0);
    });
});

describe('Jira answers and the deadline', () => {
    it('71: a 401 erases, re-asks the broker once and retries once; a second 401 is exit 1', async () => {
        const s = await scenario();
        s.jira.rejectTokens.add(TOKEN);
        const { code, err } = await s.run(['issue', 'ABC-1']);
        expect(code).toBe(1);
        expect(err).toContain('credential rejected');
        expect(s.ask.count).toBe(2);
        expect(s.ask.erased).toBe(1);
        expect(s.jira.calls).toHaveLength(2);
    });

    it('72: a 403 and a 404 are exit 1 with the closed reason and no reconnect guidance', async () => {
        const s = await scenario();
        s.jira.issueStatus = 403;
        const denied = await s.run(['issue', 'ABC-1']);
        expect(denied.code).toBe(1);
        expect(JSON.parse(denied.out)).toMatchObject({ reason: 'provider-denied' });
        expect(denied.err.toLowerCase()).not.toContain('reconnect');
        s.jira.issueStatus = 404;
        const missing = await s.run(['issue', 'ABC-1']);
        expect(missing.code).toBe(1);
        expect(JSON.parse(missing.out)).toMatchObject({ reason: 'not-found' });
        expect(missing.err.toLowerCase()).not.toContain('reconnect');
    });

    it('73: a cached token past expiry minus the skew is re-asked of the broker (real broker library)', async () => {
        const broker = require_(BROKER) as {
            connectionCredential: (id: string, deps: unknown) => Promise<Result>;
            RENEW_SKEW_MS: number;
        };
        const s = await scenario();
        const dir = mkdtempSync(join(tmpdir(), 'jira-helper-cache-'));
        dirs.push(dir);
        const clock = { t: Date.now() };
        const overrides: Partial<Deps> = {
            now: () => clock.t,
            credential: (id, remainingMs) =>
                broker.connectionCredential(id, {
                    env: { FACTORY_STATS_URL: s.boardUrl },
                    dir,
                    now: () => clock.t,
                    fetch: globalThis.fetch,
                    sleep: async () => undefined,
                    signal: (ms: number) => AbortSignal.timeout(ms),
                    stderr: () => undefined,
                    pair: async () => ({ jobId: JOB, leaseToken: LEASE }),
                    deadlineMs: remainingMs,
                }),
        };
        expect((await s.run(['issue', 'ABC-1'], overrides)).code).toBe(0);
        expect((await s.run(['issue', 'ABC-1'], overrides)).code).toBe(0);
        expect(s.board.brokerAsks).toBe(1);
        clock.t += 3600_000 - broker.RENEW_SKEW_MS + 1000;
        expect((await s.run(['issue', 'ABC-1'], overrides)).code).toBe(0);
        expect(s.board.brokerAsks).toBe(2);
    });

    it('74: a Jira that never answers ends the call at the one wall-clock deadline', async () => {
        const s = await scenario({ deadlineMs: 600 });
        s.jira.stall = true;
        const started = Date.now();
        const { code } = await s.run(['issue', 'ABC-1']);
        expect(code).toBe(1);
        expect(Date.now() - started).toBeLessThan(3000);
    });
});
