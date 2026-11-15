import { MEMBER_ROLE } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { classOf, roleOf } from '../src/auth/route-class.js';
import { githubAuth, memoryAuthStore, signedIn, staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';
import { HTTP_BAD_REQUEST, HTTP_NO_CONTENT, HTTP_UNAUTHORIZED, trackApps } from './helpers-http.js';

/**
 * Offline: the HTTP contract of the onboarding setup routes against the in-memory store double. The SQL behind
 * them (array ops, the completion timestamp) is covered by server/test-db/auth-membership.test.ts.
 */

const track = trackApps();

async function boot() {
    const auth = memoryAuthStore();
    const member = auth.seedMember('test-org', 'octocat');
    const other = auth.seedMember('test-org', 'hubot');
    const config = testConfig({ auth: githubAuth() });
    const instance = await buildApp({
        config,
        orgs: staticRegistry({ config, telemetry: stubTelemetryClient() }),
        auth,
    });
    track(instance);
    const cookie = await signedIn(auth, member);
    const otherCookie = await signedIn(auth, other);
    const setupOf = async (as = cookie) =>
        (await instance.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: as } })).json().setup;
    const post = (url: string, payload?: object, headers: Record<string, string> = { cookie }) =>
        instance.inject({ method: 'POST', url, headers, ...(payload ? { payload } : {}) });
    return { otherCookie, setupOf, post };
}

describe('POST /api/onboarding/setup', () => {
    it('records a skip, then the same step done, for the caller’s own membership', async () => {
        const { otherCookie, setupOf, post } = await boot();

        expect((await post('/api/onboarding/setup', { step: 'model', action: 'skip' })).statusCode).toBe(
            HTTP_NO_CONTENT
        );
        expect(await setupOf()).toEqual({ completed: false, done: [], skipped: ['model'] });

        expect((await post('/api/onboarding/setup', { step: 'model', action: 'done' })).statusCode).toBe(
            HTTP_NO_CONTENT
        );
        expect(await setupOf()).toEqual({ completed: false, done: ['model'], skipped: [] });
        // Another member's row is untouched.
        expect(await setupOf(otherCookie)).toEqual({ completed: false, done: [], skipped: [] });
    });

    it.each([
        ['an unknown step', { step: 'repos', action: 'skip' }],
        ['an unknown action', { step: 'model', action: 'finish' }],
        ['a missing step', { action: 'skip' }],
        ['no body', undefined],
    ])('refuses %s with 400 BAD_BODY', async (_name, payload) => {
        const { setupOf, post } = await boot();
        const response = await post('/api/onboarding/setup', payload);
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json()).toMatchObject({ code: 'BAD_BODY' });
        expect(await setupOf()).toEqual({ completed: false, done: [], skipped: [] });
    });

    it('answers 401 without a session', async () => {
        const { post } = await boot();
        const response = await post('/api/onboarding/setup', { step: 'model', action: 'skip' }, {});
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });
});

describe('POST /api/onboarding/setup/complete', () => {
    it('completes setup, and completing again changes nothing', async () => {
        const { otherCookie, setupOf, post } = await boot();

        expect((await post('/api/onboarding/setup/complete')).statusCode).toBe(HTTP_NO_CONTENT);
        expect(await setupOf()).toEqual({ completed: true, done: [], skipped: [] });
        expect((await post('/api/onboarding/setup/complete')).statusCode).toBe(HTTP_NO_CONTENT);
        expect(await setupOf()).toEqual({ completed: true, done: [], skipped: [] });
        expect(await setupOf(otherCookie)).toEqual({ completed: false, done: [], skipped: [] });
    });

    it('answers 401 without a session', async () => {
        const { post } = await boot();
        expect((await post('/api/onboarding/setup/complete', undefined, {})).statusCode).toBe(HTTP_UNAUTHORIZED);
    });
});

describe('the onboarding setup routes’ class', () => {
    it.each(['/api/onboarding/setup', '/api/onboarding/setup/complete'])(
        '%s is a member route no scoped grant reaches',
        (pattern) => {
            expect(classOf('POST', pattern)).toBe('none');
            expect(roleOf('POST', pattern)).toBe(MEMBER_ROLE);
        }
    );
});
