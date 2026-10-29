import { describe, expect, it } from 'vitest';
import type { IntegrationOutcome } from '@factory-ai/core';
import { buildApp } from '../src/app.js';
import type { AttemptCheck, AttemptOfLease } from '../src/db/attempt-of-lease.js';
import type { ResolveResult } from '../src/integrations/credential-resolver.js';
import { isTrustedContext, type TrustedIntegrationContext } from '../src/integrations/trusted-context.js';
import { githubAuth, memoryAuthStore, staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';
import { HTTP_FORBIDDEN, HTTP_OK, HTTP_SERVICE_UNAVAILABLE, HTTP_UNAUTHORIZED, trackApps } from './helpers-http.js';

/**
 * Offline: the managed-connection broker route's HTTP contract (docs/connections.md) against a stub
 * per-call check and a stub resolver. The check's SQL and the real resolver are pinned on a database by
 * server/test-db/connection-credential.test.ts.
 */

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const CONNECTION_ID = '44444444-4444-4444-8444-444444444444';
const ROOT_ID = '55555555-5555-4555-8555-555555555555';
const USER_ID = '66666666-6666-4666-8666-666666666666';
const TOKEN = 'access-route-test-secret-token-value';
const PAIR = { 'x-factory-job-id': JOB_ID, 'x-factory-job-lease-token': LEASE };
const URL_PATH = `/api/jobs/${JOB_ID}/credentials/connections/${CONNECTION_ID}`;
const HTTP_TOO_MANY = 429;
const HTTP_CONFLICT = 409;
const EXPIRES_AT_MS = Date.parse('2026-10-29T12:00:00.000Z');

const LIVE: AttemptCheck = {
    ok: true,
    orgId: 'local',
    jobId: JOB_ID,
    rootJobId: ROOT_ID,
    repo: 'acme/widgets',
    rootRepo: 'acme/widgets',
    executionUserId: USER_ID,
    claimSeq: 3,
};

const OK: ResolveResult = {
    ok: true,
    credential: { accessToken: TOKEN, expiresAt: EXPIRES_AT_MS, authority: { scopes: ['fake:read'] } },
    resource: 'acme',
    lifecycle: { refreshable: true, revocable: false },
};

const track = trackApps();

interface Boot {
    /** The check's answers in call order; the last one repeats. A function throws on that call. */
    answers?: (AttemptCheck | (() => never))[];
    resolve?: (
        ctx: TrustedIntegrationContext,
        request: { rootJobId: string; connectionId: string }
    ) => Promise<ResolveResult>;
}

async function boot({ answers = [LIVE], resolve = async () => OK }: Boot = {}) {
    const lines: string[] = [];
    const resolved: { ctx: TrustedIntegrationContext; request: { rootJobId: string; connectionId: string } }[] = [];
    let call = 0;
    const attemptOfLease: AttemptOfLease = async (jobId, leaseToken) => {
        const answer = answers[Math.min(call, answers.length - 1)] ?? { ok: false };
        call += 1;
        if (typeof answer === 'function') return answer();
        return jobId === JOB_ID && leaseToken === LEASE ? answer : { ok: false };
    };
    const config = testConfig({ auth: githubAuth() });
    const app = await buildApp({
        config,
        orgs: staticRegistry({ config, telemetry: stubTelemetryClient() }),
        auth: memoryAuthStore(),
        attemptOfLease,
        integrations: {
            resolverOf: () => ({
                resolveCredential: async (
                    ctx: TrustedIntegrationContext,
                    request: { rootJobId: string; connectionId: string }
                ) => {
                    resolved.push({ ctx, request });
                    return resolve(ctx, request);
                },
            }),
        },
        logger: { level: 'trace', stream: { write: (line: string) => lines.push(line) } },
    });
    track(app);
    return { app, lines, resolved, checks: () => call };
}

const ask = (app: Awaited<ReturnType<typeof boot>>['app'], url = URL_PATH, headers: Record<string, string> = PAIR) =>
    app.inject({ method: 'POST', url, headers });

const outcome = (o: IntegrationOutcome): ResolveResult => ({ ok: false, outcome: o });

describe('the managed-connection broker route', () => {
    it('answers a live attempt with the token, its expiry, scopes, resource and lifecycle, never cached', async () => {
        const { app, resolved, checks } = await boot();
        const res = await ask(app);
        expect(res.statusCode).toBe(HTTP_OK);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.json()).toEqual({
            token: TOKEN,
            expiresAt: new Date(EXPIRES_AT_MS).toISOString(),
            scopes: ['fake:read'],
            resource: 'acme',
            refreshable: true,
            revocable: false,
        });
        // The resolver is asked as the root's execution user, for the thread root and the named connection.
        expect(resolved).toHaveLength(1);
        expect(isTrustedContext(resolved[0]?.ctx)).toBe(true);
        expect(resolved[0]?.ctx.principal).toEqual({ kind: 'user', userId: USER_ID });
        expect(resolved[0]?.ctx.initiator).toEqual({ kind: 'job', jobId: JOB_ID, attempt: 3 });
        expect(resolved[0]?.request).toEqual({ rootJobId: ROOT_ID, connectionId: CONNECTION_ID });
        // Checked before the resolve and again after it.
        expect(checks()).toBe(2);
    });

    it('answers a token that does not expire with a null expiry', async () => {
        const { app } = await boot({
            resolve: async () => ({
                ...OK,
                credential: { accessToken: TOKEN, expiresAt: null, authority: { scopes: [] } },
            }),
        });
        expect((await ask(app)).json().expiresAt).toBeNull();
    });

    // The closed answer of every resolver outcome (the table in docs/connections.md).
    it.each<{ name: string; result: ResolveResult; status: number; code: string; retryAfter?: string }>([
        {
            name: 'integration_required',
            result: outcome({ outcome: 'integration_required', reason: 'reconnect', provider: 'jira' }),
            status: HTTP_CONFLICT,
            code: 'INTEGRATION_REQUIRED',
        },
        {
            name: 'integration_required with missing scopes',
            result: outcome({
                outcome: 'integration_required',
                reason: 'insufficient_scopes',
                provider: 'jira',
                missingScopes: ['fake:write'],
            }),
            status: HTTP_CONFLICT,
            code: 'INTEGRATION_REQUIRED',
        },
        {
            name: 'forbidden',
            result: outcome({ outcome: 'forbidden', reason: 'principal-mismatch' }),
            status: HTTP_FORBIDDEN,
            code: 'CONNECTION_NOT_AUTHORIZED',
        },
        {
            name: 'unavailable',
            result: outcome({ outcome: 'unavailable', reason: 'secret-unavailable', retryable: true }),
            status: HTTP_SERVICE_UNAVAILABLE,
            code: 'UNAVAILABLE',
            retryAfter: '1',
        },
        {
            name: 'rate_limited with a wait',
            result: outcome({ outcome: 'rate_limited', retryAfterMs: 2500 }),
            status: HTTP_TOO_MANY,
            code: 'UNAVAILABLE',
            retryAfter: '3',
        },
        {
            name: 'rate_limited without a wait',
            result: outcome({ outcome: 'rate_limited' }),
            status: HTTP_TOO_MANY,
            code: 'UNAVAILABLE',
            retryAfter: '1',
        },
    ])('maps $name to its status and a closed body', async ({ result, status, code, retryAfter }) => {
        const { app } = await boot({ resolve: async () => result });
        const res = await ask(app);
        expect(res.statusCode).toBe(status);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.json().code).toBe(code);
        if (result.ok) throw new Error('unreachable');
        expect(res.json().outcome).toEqual(result.outcome);
        expect(res.headers['retry-after']).toBe(retryAfter);
        expect(res.body).not.toContain(TOKEN);
    });

    it('marks an unavailable answer retryable', async () => {
        const { app } = await boot({
            resolve: async () => outcome({ outcome: 'unavailable', reason: 'timeout', retryable: true }),
        });
        expect((await ask(app)).json().retryable).toBe(true);
    });

    it('refuses an attempt the check refuses, and resolves nothing for it', async () => {
        const { app, resolved } = await boot({ answers: [{ ok: false }] });
        const res = await ask(app);
        expect(res.statusCode).toBe(HTTP_FORBIDDEN);
        expect(res.json().code).toBe('CONNECTION_NOT_AUTHORIZED');
        expect(resolved).toEqual([]);
    });

    it('answers 503 retryable, not a refusal, when the check cannot be read', async () => {
        const { app, resolved } = await boot({
            answers: [
                () => {
                    throw new Error('connection terminated');
                },
            ],
        });
        const res = await ask(app);
        expect(res.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(res.json()).toMatchObject({ code: 'UNAVAILABLE', retryable: true });
        expect(resolved).toEqual([]);
    });

    it('withholds the token when the attempt ended during the resolve', async () => {
        const { app, lines } = await boot({ answers: [LIVE, { ok: false }] });
        const res = await ask(app);
        expect(res.statusCode).toBe(HTTP_FORBIDDEN);
        expect(res.body).not.toContain(TOKEN);
        expect(lines.join('\n')).not.toContain(TOKEN);
    });

    it('withholds the token when the recheck cannot be read', async () => {
        const { app } = await boot({
            answers: [
                LIVE,
                () => {
                    throw new Error('connection terminated');
                },
            ],
        });
        const res = await ask(app);
        expect(res.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(res.body).not.toContain(TOKEN);
    });

    it('answers 503 without the thrown text when the resolver itself throws', async () => {
        const { app, lines } = await boot({
            resolve: async () => {
                throw new Error(`boom ${TOKEN}`);
            },
        });
        const res = await ask(app);
        expect(res.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(res.body).not.toContain(TOKEN);
        expect(lines.join('\n')).not.toContain(TOKEN);
    });

    it('keeps the token out of every log line of a successful answer', async () => {
        const { app, lines } = await boot();
        const res = await ask(app);
        expect(res.statusCode).toBe(HTTP_OK);
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.join('\n')).not.toContain(TOKEN);
    });

    it.each([
        ['connection id', `/api/jobs/${JOB_ID}/credentials/connections/not-a-uuid`, PAIR],
        [
            'job id',
            `/api/jobs/not-a-uuid/credentials/connections/${CONNECTION_ID}`,
            { ...PAIR, 'x-factory-job-id': 'not-a-uuid' },
        ],
        ['lease token', URL_PATH, { ...PAIR, 'x-factory-job-lease-token': 'not-a-uuid' }],
    ])('refuses a %s that is not a uuid without asking the check or the resolver', async (_name, url, headers) => {
        const { app, checks, resolved } = await boot();
        const res = await ask(app, url, headers);
        expect(res.statusCode).toBe(HTTP_FORBIDDEN);
        expect(res.json().code).toBe('CONNECTION_NOT_AUTHORIZED');
        expect(checks()).toBe(0);
        expect(resolved).toEqual([]);
    });

    it('takes the attempt pair and nothing else', async () => {
        const { app, resolved } = await boot();
        expect((await app.inject({ method: 'POST', url: URL_PATH })).statusCode).toBe(HTTP_UNAUTHORIZED);
        const crossed = await ask(
            app,
            `/api/jobs/33333333-3333-4333-8333-333333333333/credentials/connections/${CONNECTION_ID}`
        );
        expect(crossed.statusCode).toBe(HTTP_UNAUTHORIZED);
        expect(resolved).toEqual([]);
    });

    it('ignores any scope, resource or url the request names', async () => {
        const { app, resolved } = await boot();
        const res = await app.inject({
            method: 'POST',
            url: `${URL_PATH}?scopes=admin&resource=other&url=https://evil.example`,
            headers: { ...PAIR, 'content-type': 'application/json' },
            payload: { scopes: ['admin'], resource: 'other', url: 'https://evil.example' },
        });
        expect(res.statusCode).toBe(HTTP_OK);
        expect(resolved[0]?.request).toEqual({ rootJobId: ROOT_ID, connectionId: CONNECTION_ID });
    });
});
