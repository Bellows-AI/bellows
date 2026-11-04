import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { boundCallerOf } from '../src/auth/bridge-binding.js';
import type { Caller } from '../src/auth/store.js';
import { createBridge } from '../src/mcp/bridge.js';
import {
    githubAuth,
    memoryAuthStore,
    staticRegistry,
    stubTelemetryClient,
    telemetryStoreStub,
    testConfig,
} from './helpers.js';
import { HTTP_FORBIDDEN, HTTP_OK, trackApps } from './helpers-http.js';

const track = trackApps();
const FAR = () => Date.now() + 60_000;
const SHORT_DEADLINE_MS = 80;

/** A bare Fastify app whose routes report what they were handed, so the bridge's inputs are what is asserted. */
async function probeApp() {
    const app = track(Fastify());
    const seen: { aborted: number } = { aborted: 0 };
    app.get('/echo', async (request) => ({
        headers: request.headers,
        bound: boundCallerOf(request.raw)?.user.login ?? null,
    }));
    app.post('/echo', async (request) => ({ headers: request.headers, body: request.body }));
    app.get('/hang', async (request) => {
        await new Promise<void>((resolve) => request.raw.once('close', resolve));
        seen.aborted += 1;
        return {};
    });
    app.get('/text', async (_request, reply) => reply.type('text/plain').send('not json'));
    await app.ready();
    return { app, seen };
}

const caller = (login: string, scopes: Caller['scopes']): Caller => {
    const store = memoryAuthStore();
    return { ...store.seedMember('org-a', login, 'admin'), scopes };
};

describe('the bridge', () => {
    it('binds the caller and forwards no header but Idempotency-Key', async () => {
        const { app } = await probeApp();
        const bridge = createBridge(app);
        const outcome = await bridge.call(
            caller('octocat', ['factory:read']),
            { method: 'POST', url: '/echo', body: { a: 1 }, idempotencyKey: 'k-1' },
            { deadlineAt: FAR() }
        );
        expect(outcome.kind).toBe('response');
        const body = (outcome as { body: { headers: Record<string, string>; body: unknown } }).body;
        expect(body.body).toEqual({ a: 1 });
        expect(body.headers['idempotency-key']).toBe('k-1');
        for (const name of ['authorization', 'cookie', 'x-forwarded-for', 'origin']) {
            expect(body.headers[name]).toBeUndefined();
        }
        const bound = await bridge.call(
            caller('octocat', ['factory:read']),
            { method: 'GET', url: '/echo' },
            { deadlineAt: FAR() }
        );
        expect((bound as { body: { bound: string } }).body.bound).toBe('octocat');
    });

    it('treats a non-JSON body as an undefined body, not a throw', async () => {
        const { app } = await probeApp();
        const outcome = await createBridge(app).call(
            caller('octocat', 'all'),
            { method: 'GET', url: '/text' },
            { deadlineAt: FAR() }
        );
        expect(outcome).toEqual({ kind: 'response', status: HTTP_OK, body: undefined });
    });

    it('gives up at the deadline and lets the route see its connection close', async () => {
        const { app, seen } = await probeApp();
        const outcome = await createBridge(app).call(
            caller('octocat', 'all'),
            { method: 'GET', url: '/hang' },
            { deadlineAt: Date.now() + SHORT_DEADLINE_MS }
        );
        expect(outcome).toEqual({ kind: 'inconclusive', reason: 'timeout' });
        await expect.poll(() => seen.aborted).toBe(1);
    });

    it('does not start once the deadline has passed', async () => {
        const { app, seen } = await probeApp();
        const outcome = await createBridge(app).call(
            caller('octocat', 'all'),
            { method: 'GET', url: '/hang' },
            { deadlineAt: Date.now() - 1 }
        );
        expect(outcome).toEqual({ kind: 'inconclusive', reason: 'timeout' });
        expect(seen.aborted).toBe(0);
    });

    it('stops on the caller leaving and leaves no inject behind', async () => {
        const { app, seen } = await probeApp();
        const leaving = new AbortController();
        const pending = createBridge(app).call(
            caller('octocat', 'all'),
            { method: 'GET', url: '/hang' },
            { deadlineAt: FAR(), signal: leaving.signal }
        );
        setTimeout(() => leaving.abort(), SHORT_DEADLINE_MS);
        expect(await pending).toEqual({ kind: 'inconclusive', reason: 'aborted' });
        await expect.poll(() => seen.aborted).toBe(1);
    });

    it('does not start when the signal is already aborted', async () => {
        const { app, seen } = await probeApp();
        const outcome = await createBridge(app).call(
            caller('octocat', 'all'),
            { method: 'GET', url: '/hang' },
            { deadlineAt: FAR(), signal: AbortSignal.abort() }
        );
        expect(outcome).toEqual({ kind: 'inconclusive', reason: 'aborted' });
        expect(seen.aborted).toBe(0);
    });
});

describe('the bridge through the real auth plugin', () => {
    async function board(orgs: readonly string[]) {
        const store = memoryAuthStore();
        const config = testConfig({ auth: githubAuth() });
        const app = track(
            await buildApp({
                config,
                orgs: staticRegistry({ config, telemetry: stubTelemetryClient(), orgsFor: orgs }),
                store: telemetryStoreStub(),
                auth: store,
            })
        );
        return { app, store };
    }

    it('enforces the scope: a read grant reads and is refused a write', async () => {
        const { app, store } = await board(['org-a']);
        const reader: Caller = { ...store.seedMember('org-a', 'octocat', 'admin'), scopes: ['factory:read'] };
        const bridge = createBridge(app);
        const read = await bridge.call(reader, { method: 'GET', url: '/api/org/members' }, { deadlineAt: FAR() });
        expect(read).toMatchObject({ kind: 'response', status: HTTP_OK });
        const write = await bridge.call(
            reader,
            { method: 'POST', url: '/api/workflows', body: {} },
            { deadlineAt: FAR() }
        );
        expect(write).toMatchObject({ kind: 'response', status: HTTP_FORBIDDEN });
        expect((write as { body: { error: string } }).body.error).toBe('insufficient_scope');
    });

    it('keeps two orgs apart under concurrent calls', async () => {
        const { app, store } = await board(['org-a', 'org-b']);
        const a: Caller = { ...store.seedMember('org-a', 'alice', 'admin'), scopes: ['factory:read'] };
        const b: Caller = { ...store.seedMember('org-b', 'bob', 'admin'), scopes: ['factory:read'] };
        const bridge = createBridge(app);
        const calls = Array.from({ length: 8 }, () => [
            bridge.call(a, { method: 'GET', url: '/api/org/members' }, { deadlineAt: FAR() }),
            bridge.call(b, { method: 'GET', url: '/api/org/members' }, { deadlineAt: FAR() }),
        ]).flat();
        const answers = await Promise.all(calls);
        const logins = (index: number) => JSON.stringify((answers[index] as { body: unknown }).body);
        answers.forEach((_answer, index) => {
            const text = logins(index);
            if (index % 2 === 0) {
                expect(text).toContain('alice');
                expect(text).not.toContain('bob');
            } else {
                expect(text).toContain('bob');
                expect(text).not.toContain('alice');
            }
        });
    });

    it('refuses a route with no class, whatever the scopes are', async () => {
        const { app, store } = await board(['org-a']);
        const caller: Caller = {
            ...store.seedMember('org-a', 'octocat', 'admin'),
            scopes: ['factory:read', 'factory:write'],
        };
        const outcome = await createBridge(app).call(
            caller,
            { method: 'GET', url: '/api/health' },
            { deadlineAt: FAR() }
        );
        expect(outcome).toMatchObject({ kind: 'response', status: HTTP_FORBIDDEN });
    });
});
