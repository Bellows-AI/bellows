import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type {
    AuthorizationFlow,
    CompleteAuthorizationInput,
    CompleteAuthorizationResult,
    StartAuthorizationInput,
    StartAuthorizationResult,
} from '../src/integrations/authorization-flow.js';
import { isTrustedContext, type TrustedIntegrationContext } from '../src/integrations/trusted-context.js';
import { githubAuth, memoryAuthStore, signedIn, staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';
import {
    HTTP_BAD_REQUEST,
    HTTP_CREATED,
    HTTP_NOT_FOUND,
    HTTP_SERVICE_UNAVAILABLE,
    HTTP_UNAUTHORIZED,
    trackApps,
} from './helpers-http.js';

/**
 * Offline: the Jira start and callback routes' HTTP contract (docs/api.md) against a stub flow. The flow's own
 * transaction is pinned on a database by server/test-db/jira-authorization.test.ts.
 */

const HTTP_SEE_OTHER = 303;
const SECRET_CODE = 'code-SECRET-9f8e7d6c';
const SECRET_STATE = 'state-SECRET-1a2b3c4d';
const AUTHORIZE_URL = 'https://auth.example.test/authorize?client_id=c&state=s';

const track = trackApps();

interface Boot {
    start?: (input: StartAuthorizationInput) => StartAuthorizationResult | Promise<StartAuthorizationResult>;
    complete?: (input: CompleteAuthorizationInput) => CompleteAuthorizationResult;
}

async function boot({ start, complete }: Boot = {}) {
    const lines: string[] = [];
    const started: { ctx: TrustedIntegrationContext; input: StartAuthorizationInput }[] = [];
    const completed: (CompleteAuthorizationInput & { signal?: AbortSignal | undefined })[] = [];
    const flow: AuthorizationFlow = {
        startAuthorization: async (ctx, input) => {
            started.push({ ctx, input });
            return (
                (await start?.(input)) ?? {
                    ok: true,
                    authorizationId: 'a-1',
                    authorizeUrl: AUTHORIZE_URL,
                    expiresAt: '2026-10-29T12:00:00.000Z',
                }
            );
        },
        completeAuthorization: async (_ctx, input, options) => {
            completed.push({ ...input, signal: options?.signal });
            return complete?.(input) ?? { ok: true, returnTo: '/settings/workspace?tab=x', connectionId: 'c-1' };
        },
        recoverAuthorization: async () => 'idle',
    };
    const auth = memoryAuthStore();
    const member = auth.seedMember('test-org', 'octocat');
    const config = testConfig({ auth: githubAuth() });
    const app = await buildApp({
        config,
        orgs: staticRegistry({ config, telemetry: stubTelemetryClient() }),
        auth,
        integrations: {
            resolverOf: () => ({
                resolveCredential: async () => {
                    throw new Error('unused');
                },
            }),
            flowOf: () => flow,
        },
        logger: { level: 'trace', stream: { write: (line: string) => lines.push(line) } },
    });
    track(app);
    return { app, lines, started, completed, cookie: await signedIn(auth, member) };
}

const post = (
    ctx: Awaited<ReturnType<typeof boot>>,
    body: unknown,
    provider = 'jira',
    headers: Record<string, string> = { cookie: ctx.cookie }
) =>
    ctx.app.inject({
        method: 'POST',
        url: `/api/integrations/${provider}/authorizations`,
        headers: { 'content-type': 'application/json', ...headers },
        payload: JSON.stringify(body),
    });

const callback = (
    ctx: Awaited<ReturnType<typeof boot>>,
    query: string,
    headers: Record<string, string> = { cookie: ctx.cookie }
) => ctx.app.inject({ method: 'GET', url: `/api/integrations/jira/callback?${query}`, headers });

describe('POST /api/integrations/:provider/authorizations', () => {
    it('answers 503 INTEGRATION_NOT_CONFIGURED naming the two env names when Jira is not configured', async () => {
        const ctx = await boot({ start: () => ({ ok: false, reason: 'unknown-provider' }) });
        const response = await post(ctx, {});
        expect(response.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(response.json().code).toBe('INTEGRATION_NOT_CONFIGURED');
        expect(response.json().error).toContain('ATLASSIAN_CLIENT_ID');
        expect(response.json().error).toContain('ATLASSIAN_CLIENT_SECRET');
        const noClient = await boot({ start: () => ({ ok: false, reason: 'not-configured' }) });
        expect((await post(noClient, {})).statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
    });

    it('answers 201 with the authorize URL, no-store, and passes the whole body to the flow as the caller', async () => {
        const ctx = await boot();
        const response = await post(ctx, {
            connectionId: '11111111-1111-4111-8111-111111111111',
            returnTo: '/settings/workspace',
            interactionId: '22222222-2222-4222-8222-222222222222',
            access: 'write',
            site: 'example.atlassian.net',
        });
        expect(response.statusCode).toBe(HTTP_CREATED);
        expect(response.json()).toEqual({
            authorizationId: 'a-1',
            authorizeUrl: AUTHORIZE_URL,
            expiresAt: '2026-10-29T12:00:00.000Z',
        });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(ctx.started[0]!.input).toEqual({
            provider: 'jira',
            connectionId: '11111111-1111-4111-8111-111111111111',
            returnTo: '/settings/workspace',
            interactionId: '22222222-2222-4222-8222-222222222222',
            access: 'write',
            site: 'example.atlassian.net',
        });
        expect(isTrustedContext(ctx.started[0]!.ctx)).toBe(true);
    });

    it('passes a jobId to the flow, and a refusal of it is a 400', async () => {
        const ctx = await boot();
        const jobId = '33333333-3333-4333-8333-333333333333';
        expect((await post(ctx, { jobId, returnTo: '/tasks/x' })).statusCode).toBe(HTTP_CREATED);
        expect(ctx.started[0]!.input).toEqual({ provider: 'jira', jobId, returnTo: '/tasks/x' });
        expect((await post(ctx, { jobId: 7 })).statusCode).toBe(HTTP_BAD_REQUEST);
        const refused = await boot({ start: () => ({ ok: false, reason: 'bad-input' }) });
        expect((await post(refused, { jobId: 'nope' })).statusCode).toBe(HTTP_BAD_REQUEST);
    });

    it('answers 400 for an unknown key or a refusal of the input, 404 for an unknown provider, 401 without a session', async () => {
        const ctx = await boot();
        expect((await post(ctx, { surprise: 1 })).statusCode).toBe(HTTP_BAD_REQUEST);
        expect(ctx.started).toHaveLength(0);
        const refused = await boot({ start: () => ({ ok: false, reason: 'bad-input' }) });
        expect((await post(refused, { access: 'admin' })).statusCode).toBe(HTTP_BAD_REQUEST);
        expect((await post(refused, { site: 'example.com' })).statusCode).toBe(HTTP_BAD_REQUEST);
        const missing = await boot({ start: () => ({ ok: false, reason: 'not-found' }) });
        expect((await post(missing, { connectionId: '11111111-1111-4111-8111-111111111111' })).statusCode).toBe(
            HTTP_NOT_FOUND
        );
        const unknown = await boot({ start: () => ({ ok: false, reason: 'unknown-provider' }) });
        expect((await post(unknown, {}, 'nope')).statusCode).toBe(HTTP_NOT_FOUND);
        expect((await post(ctx, {}, 'jira', {})).statusCode).toBe(HTTP_UNAUTHORIZED);
    });
});

describe('GET /api/integrations/:provider/callback', () => {
    it('redirects 303 to the stored path with integration=jira&result=connected; a forged returnTo is ignored', async () => {
        const ctx = await boot();
        const response = await callback(
            ctx,
            `state=${SECRET_STATE}&code=${SECRET_CODE}&returnTo=https://evil.example/`
        );
        expect(response.statusCode).toBe(HTTP_SEE_OTHER);
        expect(response.headers.location).toBe('/settings/workspace?tab=x&integration=jira&result=connected');
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['referrer-policy']).toBe('no-referrer');
        expect(ctx.completed[0]).toMatchObject({ state: SECRET_STATE, code: SECRET_CODE });
        expect(ctx.completed[0]!.signal).toBeInstanceOf(AbortSignal);
    });

    it('redirects with the failure code, and with result=error when the flow throws', async () => {
        const failing = await boot({ complete: () => ({ ok: false, returnTo: '/', failure: 'site-mismatch' }) });
        const response = await callback(failing, `state=${SECRET_STATE}&error=access_denied`);
        expect(response.statusCode).toBe(HTTP_SEE_OTHER);
        expect(response.headers.location).toBe('/?integration=jira&result=site-mismatch');
        const throwing = await boot({
            complete: () => {
                throw new Error('integration authorization failed');
            },
        });
        const thrown = await callback(throwing, `state=${SECRET_STATE}&code=${SECRET_CODE}`);
        expect(thrown.statusCode).toBe(HTTP_SEE_OTHER);
        expect(thrown.headers.location).toBe('/?integration=jira&result=error');
    });

    it('writes no log line containing the code or the state', async () => {
        const ctx = await boot();
        await callback(ctx, `state=${SECRET_STATE}&code=${SECRET_CODE}`);
        await callback(ctx, `state=${SECRET_STATE}&code=${SECRET_CODE}`, {});
        const leaks = () => ctx.lines.filter((line) => line.includes(SECRET_CODE) || line.includes(SECRET_STATE));
        expect(leaks()).toEqual([]);
        // The detector works: any other route logs its request line, query included.
        await ctx.app.inject({
            method: 'GET',
            url: `/api/version?code=${SECRET_CODE}`,
            headers: { cookie: ctx.cookie },
        });
        expect(leaks().length).toBeGreaterThan(0);
    });

    it('answers 401 without a session in github mode', async () => {
        const ctx = await boot();
        const response = await callback(ctx, `state=${SECRET_STATE}&code=${SECRET_CODE}`, {});
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
        expect(ctx.completed).toHaveLength(0);
    });
});
