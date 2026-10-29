import { describe, expect, it } from 'vitest';
import { defineIntegration, type IntegrationOperation } from '../src/integrations/definition.js';
import type {
    ConnectionHandle,
    CredentialSource,
    FetchLike,
    FetchResponseLike,
} from '../src/integrations/operation.js';
import { runOperation } from '../src/integrations/operation.js';

const TOKEN = 'tok-secret-123';
const enc = new TextEncoder();

const def = defineIntegration({
    id: 'fake',
    kind: 'connection',
    capabilities: { read: ['r:items'], write: ['w:items'] },
    api: { origin: (resource) => `https://${resource.id}.example.test`, pathPrefix: '/api' },
    skills: [],
    isScopeError: (status, json) => status === 403 && (json as { scope?: boolean } | null)?.scope === true,
});

const handle = (scopes: readonly string[] = ['r:items', 'w:items']): ConnectionHandle => ({
    connectionId: 'c1',
    provider: 'fake',
    resource: { id: 'acme', label: 'Acme' },
    authority: { scopes },
});

const source = (scopes: readonly string[] = ['r:items', 'w:items']): CredentialSource & { calls: number } => {
    const s = {
        calls: 0,
        async acquire() {
            s.calls += 1;
            return { ok: true as const, credential: { accessToken: TOKEN, expiresAt: null, authority: { scopes } } };
        },
    };
    return s;
};

const read: IntegrationOperation<string> = {
    name: 'getItem',
    effect: 'read',
    requiredScopes: ['r:items'],
    request: (path) => ({ method: 'GET', path }),
};
const write: IntegrationOperation<string> = { ...read, name: 'putItem', effect: 'write', requiredScopes: ['w:items'] };

const respond = (status: number, json: unknown, headers: Record<string, string> = {}): FetchResponseLike =>
    bytes(status, enc.encode(JSON.stringify(json)), headers);
const bytes = (status: number, body: Uint8Array, headers: Record<string, string> = {}): FetchResponseLike => ({
    status,
    headers: { get: (n) => headers[n.toLowerCase()] ?? null },
    body: chunked([body]),
});
const chunked = (
    chunks: Uint8Array[],
    failAfter?: Error
): { getReader(): ReturnType<NonNullable<FetchResponseLike['body']>['getReader']> } & { cancelled: boolean } => {
    const state = { cancelled: false };
    return {
        get cancelled() {
            return state.cancelled;
        },
        getReader() {
            let i = 0;
            return {
                async read() {
                    const next = chunks[i++];
                    if (next) return { done: false, value: next };
                    if (failAfter) throw failAfter;
                    return { done: true };
                },
                async cancel() {
                    state.cancelled = true;
                },
            };
        },
    };
};

const fetcher = (answer: (url: string, n: number) => FetchResponseLike | Promise<FetchResponseLike>) => {
    const calls: { url: string; headers: Record<string, string>; redirect: string }[] = [];
    const fn: FetchLike = async (url, init) => {
        calls.push({ url, headers: init.headers, redirect: init.redirect });
        return answer(url, calls.length);
    };
    return Object.assign(fn, { calls });
};

const run = (
    op: IntegrationOperation<string>,
    input: string,
    f: FetchLike,
    over: { credentials?: CredentialSource; deadlineMs?: number; handle?: ConnectionHandle } = {}
) =>
    runOperation(
        def,
        op,
        {
            handle: over.handle ?? handle(),
            credentials: over.credentials ?? source(),
            fetch: f,
            deadlineMs: over.deadlineMs ?? 2000,
        },
        input
    );

describe('runOperation', () => {
    it.each([
        'https://evil.test/api/x',
        '//evil.test/api/x',
        '/api/../admin',
        '/api/%2e%2e/admin',
        'api/x',
        '/other/x',
        '/api\\..\\x',
    ])('refuses %s without calling fetch', async (path) => {
        const f = fetcher(() => respond(200, {}));
        const r = await run(read, path, f);
        expect(r).toEqual({ ok: false, outcome: { outcome: 'forbidden', reason: 'destination-refused' } });
        expect(f.calls).toHaveLength(0);
    });

    it('sends the bearer token to the definition origin', async () => {
        const f = fetcher(() => respond(200, { a: 1 }));
        const r = await run(read, '/api/items/1', f);
        expect(r).toEqual({ ok: true, value: { a: 1 } });
        expect(f.calls[0]?.url).toBe('https://acme.example.test/api/items/1');
        expect(f.calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    });

    it('does not follow a redirect', async () => {
        const f = fetcher(() => respond(302, {}, { location: 'https://evil.test/' }));
        const r = await run(read, '/api/x', f);
        expect(r).toEqual({
            ok: false,
            outcome: { outcome: 'unavailable', reason: 'redirect-refused', retryable: true },
        });
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0]?.redirect).toBe('manual');
    });

    it('missing required scope is integration_required before any request', async () => {
        const f = fetcher(() => respond(200, {}));
        const creds = source();
        const r = await run(read, '/api/x', f, { handle: handle(['other']), credentials: creds });
        expect(r).toEqual({
            ok: false,
            outcome: {
                outcome: 'integration_required',
                reason: 'insufficient_scopes',
                provider: 'fake',
                missingScopes: ['r:items'],
            },
        });
        expect(f.calls).toHaveLength(0);
        expect(creds.calls).toBe(0);
    });

    it('a 403 with all scopes present is forbidden, not insufficient_scopes', async () => {
        const f = fetcher(() => respond(403, { scope: true }));
        const r = await run(read, '/api/x', f);
        expect(r).toEqual({ ok: false, outcome: { outcome: 'forbidden', reason: 'provider-denied' } });
        const g = fetcher(() => respond(403, { nope: 1 }));
        expect(await run(read, '/api/x', g, { credentials: source(['r:items']) })).toEqual({
            ok: false,
            outcome: { outcome: 'forbidden', reason: 'provider-denied' },
        });
    });

    it('a 403 the definition marks as a scope error, with the scope missing from the token, is insufficient_scopes', async () => {
        const f = fetcher(() => respond(403, { scope: true }));
        const r = await run(read, '/api/x', f, { credentials: source(['w:items']) });
        expect(r).toEqual({
            ok: false,
            outcome: {
                outcome: 'integration_required',
                reason: 'insufficient_scopes',
                provider: 'fake',
                missingScopes: ['r:items'],
            },
        });
    });

    it('429 is rate_limited with Retry-After', async () => {
        const r = await run(
            read,
            '/api/x',
            fetcher(() => respond(429, {}, { 'retry-after': '7' }))
        );
        expect(r).toEqual({ ok: false, outcome: { outcome: 'rate_limited', retryAfterMs: 7000 } });
        const bare = await run(
            read,
            '/api/x',
            fetcher(() => respond(429, {}))
        );
        expect(bare).toEqual({ ok: false, outcome: { outcome: 'rate_limited' } });
    });

    it('401 is unavailable{credential-rejected}, never integration_required', async () => {
        const r = await run(
            read,
            '/api/x',
            fetcher(() => respond(401, {}))
        );
        expect(r).toEqual({
            ok: false,
            outcome: { outcome: 'unavailable', reason: 'credential-rejected', retryable: true },
        });
    });

    it('read 5xx and transport failure are unavailable', async () => {
        expect(
            await run(
                read,
                '/api/x',
                fetcher(() => respond(503, {}))
            )
        ).toEqual({
            ok: false,
            outcome: { outcome: 'unavailable', reason: 'upstream-error', retryable: true },
        });
        const boom: FetchLike = async () => {
            throw new Error('ECONNRESET');
        };
        expect(await run(read, '/api/x', boom)).toEqual({
            ok: false,
            outcome: { outcome: 'unavailable', reason: 'transport', retryable: true },
        });
    });

    it('write 5xx, transport failure and timeout are outcome_unknown', async () => {
        const unknown = { ok: false, outcome: { outcome: 'outcome_unknown', operation: 'putItem' } };
        expect(
            await run(
                write,
                '/api/x',
                fetcher(() => respond(502, {}))
            )
        ).toEqual(unknown);
        const boom: FetchLike = async () => {
            throw new Error('ECONNRESET');
        };
        expect(await run(write, '/api/x', boom)).toEqual(unknown);
        const hang: FetchLike = () => new Promise(() => {});
        expect(await run(write, '/api/x', hang, { deadlineMs: 10 })).toEqual(unknown);
    });

    it('a read timeout is unavailable{timeout}', async () => {
        const hang: FetchLike = () => new Promise(() => {});
        expect(await run(read, '/api/x', hang, { deadlineMs: 10 })).toEqual({
            ok: false,
            outcome: { outcome: 'unavailable', reason: 'timeout', retryable: true },
        });
    });

    it('pagination stops at maxPages', async () => {
        const paged: IntegrationOperation<string> = {
            ...read,
            paginate: {
                maxPages: 3,
                maxItems: 100,
                items: (j) => (j as { items: unknown[] }).items,
                next: () => '/api/next',
            },
        };
        const f = fetcher((_u, n) => respond(200, { items: [n] }));
        const r = await run(paged, '/api/first', f);
        expect(f.calls).toHaveLength(3);
        expect(r).toEqual({ ok: true, value: [1, 2, 3] });
    });

    it('pagination stops at maxItems and refuses a next link that leaves the destination', async () => {
        const paged: IntegrationOperation<string> = {
            ...read,
            paginate: {
                maxPages: 9,
                maxItems: 2,
                items: (j) => (j as { items: unknown[] }).items,
                next: () => '/api/next',
            },
        };
        const f = fetcher(() => respond(200, { items: ['a', 'b', 'c'] }));
        expect(await run(paged, '/api/first', f)).toEqual({ ok: true, value: ['a', 'b'] });
        expect(f.calls).toHaveLength(1);
        const evil: IntegrationOperation<string> = {
            ...paged,
            paginate: { maxPages: 9, maxItems: 99, items: () => [], next: () => 'https://evil.test/x' },
        };
        const g = fetcher(() => respond(200, {}));
        expect(await run(evil, '/api/first', g)).toEqual({
            ok: false,
            outcome: { outcome: 'forbidden', reason: 'destination-refused' },
        });
        expect(g.calls).toHaveLength(1);
    });

    it('one absolute deadline covers credential acquisition and every page', async () => {
        let aborted = false;
        const slowCreds: CredentialSource = { acquire: () => new Promise(() => {}) };
        const f = fetcher(() => respond(200, {}));
        expect(await run(read, '/api/x', f, { credentials: slowCreds, deadlineMs: 10 })).toEqual({
            ok: false,
            outcome: { outcome: 'unavailable', reason: 'timeout', retryable: true },
        });
        expect(f.calls).toHaveLength(0);

        const hang: FetchLike = (_u, init) =>
            new Promise(() => {
                init.signal.addEventListener('abort', () => {
                    aborted = true;
                });
            });
        await run(read, '/api/x', hang, { deadlineMs: 10 });
        expect(aborted).toBe(true);
    });

    it('a body over the cap is unavailable and the stream is cancelled', async () => {
        const body = chunked([new Uint8Array(600), new Uint8Array(600)]);
        const res: FetchResponseLike = { status: 200, headers: { get: () => null }, body };
        const r = await runOperation(
            def,
            read,
            { handle: handle(), credentials: source(), fetch: async () => res, deadlineMs: 2000, maxBodyBytes: 1000 },
            '/api/x'
        );
        expect(r).toEqual({
            ok: false,
            outcome: { outcome: 'unavailable', reason: 'response-too-large', retryable: true },
        });
        expect(body.cancelled).toBe(true);
    });

    it('a body that errors mid-stream settles', async () => {
        const body = chunked([enc.encode('{"a"')], new Error('reset'));
        const res: FetchResponseLike = { status: 200, headers: { get: () => null }, body };
        const r = await run(read, '/api/x', async () => res);
        expect(r).toEqual({ ok: false, outcome: { outcome: 'unavailable', reason: 'transport', retryable: true } });
    });

    it('never puts the provider body or token into an outcome', async () => {
        const r = await run(
            read,
            '/api/x',
            fetcher(() => respond(500, { echo: TOKEN }))
        );
        expect(JSON.stringify(r)).not.toContain(TOKEN);
    });
});
