import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeBoard, type Json, listen, readBody, send } from './fixtures/helper-board.js';
import { REPO_ROOT as ROOT } from './fixtures/repo-files.js';

/**
 * The runner's Linear helper (docs/connections.md): the real helper against the fake board (connection list,
 * receipts with the board's transition rules) and a fake Linear GraphQL endpoint on 127.0.0.1. Only the network
 * edges are fake; the broker and the runtime ask are injected.
 */

const HELPER = join(ROOT, 'docker/skills/factory-linear/linear.cjs');
const require_ = createRequire(import.meta.url);

interface Result {
    ok: boolean;
    token?: string;
    expiresAt?: string | null;
    scopes?: string[];
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
const helper = require_(HELPER) as { run: (argv: string[], deps: Deps) => Promise<number> };

const JOB = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const CONN_A = '33333333-3333-4333-8333-333333333333';
const CONN_B = '44444444-4444-4444-8444-444444444444';
const TOKEN = 'lin-SECRET-value';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const notFound = (what: string) => ({
    errors: [{ message: `Entity not found: ${what}`, extensions: { code: 'INPUT_ERROR' } }],
});

type PostMode = 'ok' | 'drop-after-create' | 'drop-before-create' | 'forbidden' | 'missing-issue';

/** A fake Linear GraphQL endpoint: per-call records, a comment store keyed by the client id, scripted faults. */
function fakeLinear() {
    const state = {
        calls: [] as { op: string; variables: Json; auth: string }[],
        posts: 0,
        comments: new Map<string, { issue: string; body: string }>(),
        postMode: 'ok' as PostMode,
        /** How the reconcile read `comment(id:)` answers: the store, an error, or `null` data. */
        commentRead: 'store' as 'store' | 'error' | 'null',
        rejectTokens: new Set<string>(),
        rateLimited: 0,
        stall: false,
        truncate: false,
        searchPages: [] as { nodes: unknown[]; next?: string }[],
        threads: [] as unknown[],
    };
    const page = (nodes: unknown[], next?: string) => ({
        nodes,
        pageInfo: { hasNextPage: next !== undefined, endCursor: next ?? null },
    });
    const server = createServer(async (req, res) => {
        const raw = await readBody(req);
        const auth = String(req.headers.authorization ?? '');
        const { query, variables } = JSON.parse(raw || '{}') as { query: string; variables: Json };
        const op = /^(?:query|mutation) (\w+)/.exec(query ?? '')?.[1] ?? '?';
        state.calls.push({ op, variables, auth });
        if (state.stall) return;
        if (state.truncate) {
            res.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' });
            res.write('{"data":{"issue":');
            return void setTimeout(() => req.socket.destroy(), 20);
        }
        if (state.rejectTokens.has(auth.replace('Bearer ', ''))) return send(res, 401, { errors: [{ message: 'no' }] });
        if (state.rateLimited > 0) {
            state.rateLimited--;
            return send(res, 400, { errors: [{ message: 'slow down', extensions: { code: 'RATELIMITED' } }] });
        }
        if (op === 'GetIssue') {
            return variables.id === 'ABC-404'
                ? send(res, 400, notFound('Issue'))
                : send(res, 200, { data: { issue: { identifier: variables.id, title: 'S' } } });
        }
        if (op === 'SearchIssues') {
            const index = variables.after === undefined ? 0 : Number(variables.after);
            const at = state.searchPages[index] ?? { nodes: [] };
            return send(res, 200, { data: { issues: page(at.nodes, at.next) } });
        }
        if (op === 'ListComments') {
            const start = variables.after === undefined ? 0 : Number(variables.after);
            const first = Number(variables.first);
            const slice = state.threads.slice(start, start + first);
            const next = start + first < state.threads.length ? String(start + first) : undefined;
            return send(res, 200, { data: { issue: { comments: page(slice, next) } } });
        }
        if (op === 'AddComment') {
            state.posts++;
            const input = variables.input as { id: string; issueId: string; body: string };
            if (state.postMode === 'forbidden') {
                return send(res, 200, { errors: [{ message: 'no', extensions: { code: 'FORBIDDEN' } }] });
            }
            if (state.postMode === 'missing-issue') return send(res, 400, notFound('Issue'));
            if (state.postMode === 'drop-before-create') return void req.socket.destroy();
            if (state.comments.has(input.id)) {
                return send(res, 200, { errors: [{ message: 'duplicate id', extensions: { code: 'INVALID_INPUT' } }] });
            }
            state.comments.set(input.id, { issue: input.issueId, body: input.body });
            if (state.postMode === 'drop-after-create') return void req.socket.destroy();
            return send(res, 200, { data: { commentCreate: { success: true, comment: { id: input.id } } } });
        }
        if (op === 'Comment') {
            if (state.commentRead === 'error') return send(res, 500, { errors: [{ message: 'down' }] });
            if (state.commentRead === 'null') return send(res, 200, { data: { comment: null } });
            const found = state.comments.get(String(variables.id));
            return found
                ? send(res, 200, {
                      data: { comment: { id: variables.id, issue: { id: 'i', identifier: found.issue } } },
                  })
                : send(res, 400, notFound('Comment'));
        }
        return send(res, 400, { errors: [{ message: 'unknown query' }] });
    });
    return { state, server };
}

const servers: Server[] = [];
afterEach(() => {
    for (const server of servers.splice(0)) server.close();
});

async function scenario(
    options: {
        scopes?: string[];
        connections?: 'one' | 'two' | 'none' | 'malformed' | 'with-jira' | 'bound-after-ask';
        deadlineMs?: number;
        asked?: Asked[];
    } = {}
) {
    const linear = fakeLinear();
    const linearUrl = await listen(linear.server);
    const entry = (id: string, site: string, provider = 'linear') => ({
        id,
        provider,
        site,
        resource: `org-${site}`,
        access: 'write',
        apiBase: `${linearUrl}/graphql`,
    });
    const shape = options.connections ?? 'one';
    const asks: string[] = [];
    const askTargets: (string | undefined)[] = [];
    const connections = () => {
        if (shape === 'none' || (shape === 'bound-after-ask' && asks.length === 0)) return [];
        if (shape === 'two') return [entry(CONN_A, 'ws-a'), entry(CONN_B, 'ws-b')];
        if (shape === 'malformed')
            return [entry(CONN_A, 'ws-a'), { ...entry(CONN_B, 'ws-b'), apiBase: 'ftp://x/graphql' }];
        if (shape === 'with-jira') {
            return [
                entry(CONN_A, 'ws-a'),
                { ...entry(CONN_B, 'a.example.net', 'jira'), apiBase: 'https://x/ex/jira/c/rest/api/3' },
            ];
        }
        return [entry(CONN_A, 'ws-a')];
    };
    const board = fakeBoard(connections, {
        job: JOB,
        lease: LEASE,
        issue: () => ({ token: TOKEN, expiresAt: null, scopes: ['read', 'write'], resource: 'org-ws-a' }),
    });
    const boardUrl = await listen(board.server);
    servers.push(linear.server, board.server);
    const broker = { count: 0, erased: 0, scopes: options.scopes ?? ['read', 'write'] };
    const run = async (argv: string[], overrides: Partial<Deps> = {}) => {
        let out = '';
        let err = '';
        const deps: Deps = {
            env: { FACTORY_STATS_URL: boardUrl },
            now: Date.now,
            fetch: globalThis.fetch,
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            pair: async () => ({ jobId: JOB, leaseToken: LEASE }),
            credential: async () => {
                broker.count++;
                return { ok: true, token: TOKEN, expiresAt: null, scopes: broker.scopes };
            },
            ask: async (provider, _remainingMs, target) => {
                asks.push(provider);
                askTargets.push(target);
                const scripted = options.asked ?? [{ kind: 'absent' }];
                return scripted[Math.min(asks.length - 1, scripted.length - 1)] as Asked;
            },
            eraseCredential: () => {
                broker.erased++;
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
        linear: linear.state,
        board: board.state,
        broker,
        asks,
        askTargets,
        run,
        receipts: () => [...board.state.receipts.values()],
    };
}

const last = (out: string) => JSON.parse(out.trim().split('\n').pop() ?? '{}') as Json;
const BODY = 'Looks good.\nSecond line.';
const comment = (...rest: string[]) => ['comment', 'ABC-1', '--body', BODY, ...rest];

describe('reading', () => {
    it('issue prints the issue, sends GetIssue with the bearer token, and never prints the token', async () => {
        const s = await scenario();
        const { code, out, err } = await s.run(['issue', 'ABC-1']);
        expect(code).toBe(0);
        expect(JSON.parse(out)).toEqual({ identifier: 'ABC-1', title: 'S' });
        expect(s.linear.calls).toMatchObject([{ op: 'GetIssue', variables: { id: 'ABC-1' }, auth: `Bearer ${TOKEN}` }]);
        expect(out + err).not.toContain(TOKEN);
    });

    it('an issue Linear does not have is exit 1 not-found', async () => {
        const s = await scenario();
        const { code, out } = await s.run(['issue', 'ABC-404']);
        expect(code).toBe(1);
        expect(last(out)).toMatchObject({ reason: 'not-found' });
    });

    it('search maps the flags onto the structured filter and follows endCursor', async () => {
        const s = await scenario();
        s.linear.searchPages = [
            { nodes: [{ identifier: 'A-1' }], next: '1' },
            { nodes: [{ identifier: 'A-2' }], next: '2' },
            { nodes: [{ identifier: 'A-3' }] },
        ];
        const found = await s.run([
            'search',
            '--team',
            'ENG',
            '--state',
            'In Progress',
            '--assignee',
            'me',
            '--text',
            'x y',
        ]);
        expect(found.code).toBe(0);
        expect(JSON.parse(found.out)).toEqual({
            issues: [{ identifier: 'A-1' }, { identifier: 'A-2' }, { identifier: 'A-3' }],
            truncated: false,
        });
        expect(s.linear.calls.map((c) => c.variables.after)).toEqual([undefined, '1', '2']);
        expect(s.linear.calls[0]?.variables.filter).toEqual({
            team: { key: { eq: 'ENG' } },
            state: { name: { eqIgnoreCase: 'In Progress' } },
            assignee: { isMe: { eq: true } },
            searchableContent: { contains: 'x y' },
        });
    });

    it('search stops at its bound and says truncated', async () => {
        const s = await scenario();
        s.linear.searchPages = Array.from({ length: 12 }, (_, i) => ({
            nodes: Array.from({ length: 30 }, (_x, j) => ({ identifier: `A-${i * 30 + j + 1}` })),
            next: String(i + 1),
        }));
        const found = await s.run(['search', '--label', 'Bug']);
        expect(found.code).toBe(0);
        const parsed = JSON.parse(found.out) as { issues: unknown[]; truncated: boolean };
        expect(parsed.issues).toHaveLength(200);
        expect(parsed.truncated).toBe(true);
    });

    it('search with no filter flag is exit 1 bad input and touches nothing', async () => {
        const s = await scenario();
        const { code, err } = await s.run(['search']);
        expect(code).toBe(1);
        expect(err).toContain('--team');
        expect(s.linear.calls).toHaveLength(0);
    });

    it('comments pages through the thread', async () => {
        const s = await scenario();
        s.linear.threads = Array.from({ length: 250 }, (_, i) => ({ id: String(i) }));
        const listed = await s.run(['comments', 'ABC-1']);
        expect(listed.code).toBe(0);
        expect((JSON.parse(listed.out) as { comments: unknown[] }).comments).toHaveLength(250);
        expect(s.linear.calls.map((c) => c.variables.after)).toEqual([undefined, '100', '200']);
    });

    it('a malformed issue key is exit 1 bad input before any request', async () => {
        const s = await scenario();
        const { code } = await s.run(['issue', 'abc-1']);
        expect(code).toBe(1);
        expect(s.linear.calls).toHaveLength(0);
    });
});

describe('finding the connection', () => {
    it('no binding asks for linear and exits 3', async () => {
        const s = await scenario({ connections: 'none', asked: [{ kind: 'answer', answer: 'waiting' }] });
        const { code, out } = await s.run(['issue', 'ABC-1', '--workspace', 'ws-a']);
        expect(code).toBe(3);
        expect(last(out)).toMatchObject({ outcome: 'integration_required', reason: 'waiting_for_connection' });
        expect(s.asks).toEqual(['linear']);
        expect(s.askTargets).toEqual(['ws-a']);
    });

    it('bound continues the same call after re-reading the list', async () => {
        const s = await scenario({ connections: 'bound-after-ask', asked: [{ kind: 'answer', answer: 'bound' }] });
        expect((await s.run(['issue', 'ABC-1'])).code).toBe(0);
        expect(s.asks).toEqual(['linear']);
    });

    it('two bindings without --workspace exit 1 naming --workspace; --workspace picks one', async () => {
        const s = await scenario({ connections: 'two' });
        const ambiguous = await s.run(['issue', 'ABC-1']);
        expect(ambiguous.code).toBe(1);
        expect(ambiguous.err).toContain('--workspace');
        expect(s.linear.calls).toHaveLength(0);
        expect((await s.run(['issue', 'ABC-1', '--workspace', 'WS-B'])).code).toBe(0);
    });

    it('a malformed connection list exits 1 and never asks', async () => {
        const s = await scenario({ connections: 'malformed', deadlineMs: 800 });
        const { code, out } = await s.run(['issue', 'ABC-1']);
        expect(code).toBe(1);
        expect(last(out)).toMatchObject({ outcome: 'unavailable', reason: 'malformed' });
        expect(s.asks).toEqual([]);
        expect(s.linear.calls).toHaveLength(0);
    });

    it('skips a bound Jira connection beside the Linear one', async () => {
        const s = await scenario({ connections: 'with-jira' });
        expect((await s.run(['issue', 'ABC-1'])).code).toBe(0);
        expect(s.asks).toEqual([]);
    });
});

describe('Linear answers and the deadline', () => {
    it('a 401 erases, asks for one fresh credential, and a second 401 is exit 1 credential_rejected', async () => {
        const s = await scenario();
        s.linear.rejectTokens.add(TOKEN);
        const { code, out } = await s.run(['issue', 'ABC-1']);
        expect(code).toBe(1);
        expect(last(out)).toMatchObject({ reason: 'credential_rejected' });
        expect(s.broker.count).toBe(2);
        expect(s.broker.erased).toBe(1);
        expect(s.linear.calls).toHaveLength(2);
    });

    it('RATELIMITED backs off inside the deadline and then reads', async () => {
        const s = await scenario();
        s.linear.rateLimited = 2;
        const { code } = await s.run(['issue', 'ABC-1']);
        expect(code).toBe(0);
        expect(s.linear.calls).toHaveLength(3);
    });

    it('a rate limit past the deadline exits 1 deadline', async () => {
        const s = await scenario({ deadlineMs: 600 });
        s.linear.rateLimited = 1000;
        const started = Date.now();
        const { code, out } = await s.run(['issue', 'ABC-1']);
        expect(code).toBe(1);
        expect(last(out)).toMatchObject({ reason: 'deadline' });
        expect(Date.now() - started).toBeLessThan(3000);
    });

    it('a truncated stream is unavailable, never not-found', async () => {
        const s = await scenario({ deadlineMs: 800 });
        s.linear.truncate = true;
        const { code, out } = await s.run(['issue', 'ABC-1']);
        expect(code).toBe(1);
        expect(last(out)).toMatchObject({ outcome: 'unavailable' });
        expect(last(out).reason).not.toBe('not-found');
    });

    it('a Linear that never answers ends the call at the one wall-clock deadline', async () => {
        const s = await scenario({ deadlineMs: 600 });
        s.linear.stall = true;
        const started = Date.now();
        expect((await s.run(['issue', 'ABC-1'])).code).toBe(1);
        expect(Date.now() - started).toBeLessThan(3000);
    });
});

describe('add-comment', () => {
    it('no write scope is exit 3 insufficient_scopes, no receipt, no create', async () => {
        const s = await scenario({ scopes: ['read'] });
        const { code, out } = await s.run(comment());
        expect(code).toBe(3);
        expect(JSON.parse(out)).toMatchObject({ reason: 'insufficient_scopes', missingScopes: ['write'] });
        expect(s.linear.posts).toBe(0);
        expect(s.receipts()).toHaveLength(0);
    });

    it('started, dispatched, commentCreate carrying the receipt id, succeeded; a rerun posts nothing', async () => {
        const s = await scenario();
        const first = await s.run(comment());
        expect(first.code).toBe(0);
        const receipt = s.receipts()[0];
        expect(receipt).toMatchObject({ provider: 'linear', key: sha(`${CONN_A}|ABC-1|${BODY}`) });
        expect(JSON.parse(first.out)).toEqual({ commentId: receipt?.id });
        const create = s.linear.calls.find((c) => c.op === 'AddComment');
        expect(create?.variables).toEqual({ input: { id: receipt?.id, issueId: 'ABC-1', body: BODY } });
        expect(s.board.moves.map((m) => m.to)).toEqual(['dispatched', 'succeeded']);
        expect(receipt).toMatchObject({ status: 'succeeded', result: { commentId: receipt?.id } });

        s.linear.calls.length = 0;
        const again = await s.run(comment());
        expect(again.code).toBe(0);
        expect(JSON.parse(again.out)).toEqual({ commentId: receipt?.id });
        expect(s.linear.calls).toEqual([]);
        expect(s.linear.posts).toBe(1);
    });

    it('a retry after a lost answer posts once: the next call reconciles by comment(id) and finds it', async () => {
        const s = await scenario({ deadlineMs: 1500 });
        s.linear.postMode = 'drop-after-create';
        s.linear.commentRead = 'error';
        const first = await s.run(comment());
        expect(first.code).toBe(4);
        expect(s.receipts()[0]?.status).toBe('unknown');
        s.linear.postMode = 'ok';
        s.linear.commentRead = 'store';
        const again = await s.run(comment());
        expect(again.code).toBe(0);
        const id = s.receipts()[0]?.id;
        expect(JSON.parse(again.out)).toEqual({ commentId: id });
        expect(s.receipts()[0]).toMatchObject({ status: 'succeeded', result: { commentId: id } });
        expect(s.linear.posts).toBe(1);
        expect(s.linear.calls.filter((c) => c.op === 'Comment').at(-1)?.variables).toEqual({ id });
    });

    it('a lost answer reconciles in the same call when the read finds the comment', async () => {
        const s = await scenario();
        s.linear.postMode = 'drop-after-create';
        const { code } = await s.run(comment());
        expect(code).toBe(0);
        expect(s.linear.posts).toBe(1);
        expect(s.receipts()[0]?.status).toBe('succeeded');
    });

    it('a reconcile that reads "Entity not found" re-sends with the same id', async () => {
        const s = await scenario();
        s.linear.postMode = 'drop-before-create';
        const first = await s.run(comment());
        expect(first.code).toBe(4);
        s.linear.postMode = 'ok';
        const again = await s.run(comment());
        expect(again.code).toBe(0);
        const creates = s.linear.calls.filter((c) => c.op === 'AddComment');
        expect(creates).toHaveLength(3);
        const id = s.receipts()[0]?.id;
        expect(creates.map((c) => (c.variables.input as Json).id)).toEqual([id, id, id]);
        expect(s.linear.comments.size).toBe(1);
        expect(s.receipts()[0]?.status).toBe('succeeded');
    });

    it('an unconfirmed reconcile exits 4 with the receipt unknown, and never posts again', async () => {
        for (const read of ['error', 'null'] as const) {
            const s = await scenario({ deadlineMs: 1500 });
            s.linear.postMode = 'drop-before-create';
            s.linear.commentRead = read;
            const { code, out } = await s.run(comment());
            expect(code).toBe(4);
            expect(last(out)).toMatchObject({ outcome: 'outcome_unknown' });
            expect(s.receipts()[0]?.status).toBe('unknown');
            expect(s.linear.posts).toBe(1);
        }
    });

    it('a refused create records failed and is exit 1; the failed key is not retried silently', async () => {
        const s = await scenario();
        s.linear.postMode = 'forbidden';
        const first = await s.run(comment());
        expect(first.code).toBe(1);
        expect(last(first.out)).toMatchObject({ reason: 'provider-denied' });
        expect(s.receipts()[0]?.status).toBe('failed');
        s.linear.postMode = 'ok';
        const again = await s.run(comment());
        expect(again.code).toBe(1);
        expect(again.err).toContain('--key');
        expect(s.linear.posts).toBe(1);
    });

    it('a create on an issue Linear does not have is failed, exit 1 not-found', async () => {
        const s = await scenario();
        s.linear.postMode = 'missing-issue';
        const { code, out } = await s.run(comment());
        expect(code).toBe(1);
        expect(last(out)).toMatchObject({ reason: 'not-found' });
        expect(s.receipts()[0]?.status).toBe('failed');
    });

    it('a reused key for another body is 409 and exit 1, nothing posted', async () => {
        const s = await scenario();
        expect((await s.run(comment('--key', 'k1'))).code).toBe(0);
        const reused = await s.run(['comment', 'ABC-1', '--body', 'other', '--key', 'k1']);
        expect(reused.code).toBe(1);
        expect(last(reused.out)).toMatchObject({ reason: 'key_reused' });
        expect(s.linear.posts).toBe(1);
    });

    it('losing the started to dispatched move to another invocation is exit 4, no create', async () => {
        const s = await scenario();
        s.board.conflictOnDispatch = true;
        expect((await s.run(comment())).code).toBe(4);
        expect(s.linear.posts).toBe(0);
    });

    it('--body-file: a missing file is bad input and an unreadable one says so, both before any receipt', async () => {
        const s = await scenario();
        const fail = (code: string) => () => {
            throw Object.assign(new Error('x'), { code });
        };
        const missing = await s.run(['comment', 'ABC-1', '--body-file', '/nope'], { readFile: fail('ENOENT') });
        expect(missing.code).toBe(1);
        expect(missing.err).toContain('no such file');
        const denied = await s.run(['comment', 'ABC-1', '--body-file', '/nope'], { readFile: fail('EACCES') });
        expect(denied.code).toBe(1);
        expect(denied.err).toContain('unreadable (EACCES)');
        expect(s.receipts()).toHaveLength(0);
    });
});
