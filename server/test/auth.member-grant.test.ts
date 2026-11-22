import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import {
    ORG,
    begin,
    beginOnboarding,
    callback,
    errorOf,
    finishOnboarding,
    setup,
    signIn,
} from './auth.oauth-fixtures.js';
import {
    githubAuth,
    memberGrantsFake,
    memoryAuthStore,
    staticRegistry,
    stubTelemetryClient,
    testConfig,
} from './helpers.js';
import { HTTP_FOUND, HTTP_OK, HTTP_UNAUTHORIZED } from './helpers-http.js';

/**
 * What a sign-in does with the App user token pair it obtained: the callback hands it to the member's GitHub
 * grant after the member exists, in the org the session is for; a grant that cannot be stored never blocks the
 * sign-in; a parked sign-in drops the pair and the completion goes round the authorize trip again.
 */

describe('the sign-in keeps the member’s GitHub grant', () => {
    it('stores the pair for the signed-in member, in the selected org, keyed by their GitHub id', async () => {
        const memberGrants = memberGrantsFake();
        const { app, auth, identity } = await setup({ memberGrants });

        await signIn(app);

        const caller = await auth.signIn(identity.next, ORG, [{ id: ORG, name: 'acme' }]);
        expect(memberGrants.stored).toEqual([
            {
                orgId: ORG,
                userId: caller.user.id,
                forge: 'github',
                externalAccountId: String(identity.next.githubUserId),
                tokens: { accessToken: 'access-for-abc', refreshToken: 'refresh-for-abc', expiresIn: 28_800 },
            },
        ]);
    });

    it('stores again on the next sign-in: every sign-in replaces the grant', async () => {
        const memberGrants = memberGrantsFake();
        const { app } = await setup({ memberGrants });

        await signIn(app);
        await signIn(app);

        expect(memberGrants.stored).toHaveLength(2);
    });

    it.each([
        ['cannot be reached', new Error('secret store down')],
        ['is busy refreshing', { ok: false, reason: 'busy' } as const],
    ])('still signs the member in when the grant store %s', async (_name, answer) => {
        const memberGrants = memberGrantsFake();
        memberGrants.storeAnswer = answer;
        const { app, auth } = await setup({ memberGrants });

        const cookie = await signIn(app);

        expect(cookie).toBeTruthy();
        expect(auth.sessions()).toHaveLength(1);
    });

    it('stores nothing when the sign-in fails before the member exists', async () => {
        const memberGrants = memberGrantsFake();
        const { app, identity } = await setup({ memberGrants });
        identity.installationsError = new Error('github unreachable');

        const state = await begin(app);
        const response = await callback(app, `code=abc&state=${encodeURIComponent(state)}`, state);

        expect(errorOf(response.headers.location as string)).toBe('github');
        expect(memberGrants.stored).toEqual([]);
    });

    it('drops the pair of a parked sign-in, and the completion goes round the authorize trip to store it', async () => {
        // A first sign-in with two installations parks before any user or org row exists: nothing to key a grant on.
        const memberGrants = memberGrantsFake();
        const { app } = await setup({
            memberGrants,
            installations: [
                { id: '888888', account: 'other-org' },
                { id: ORG, account: 'acme' },
            ],
        });
        const pending = await beginOnboarding(app, '/tasks');
        expect(memberGrants.stored).toEqual([]);

        const response = await finishOnboarding(app, pending, { orgs: [ORG] });

        expect(response.statusCode).toBe(HTTP_OK);
        const next = new URL(response.json().returnTo as string, 'http://board.test');
        expect(next.pathname).toBe('/api/auth/github');
        expect(next.searchParams.get('returnTo')).toBe('/tasks');
        expect(next.searchParams.get('org')).toBe(ORG);
        expect(response.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBeTruthy();

        // The trip itself is silent now (a stored selection) and keeps the grant.
        const state = await begin(app, '/tasks', ORG);
        const back = await callback(app, `code=abc&state=${encodeURIComponent(state)}`, state);
        expect(back.statusCode).toBe(HTTP_FOUND);
        expect(back.headers.location).toBe('/tasks');
        expect(memberGrants.stored).toHaveLength(1);
    });

    it('leaves the completion’s destination alone where no grant is kept', async () => {
        const { app } = await setup({
            installations: [
                { id: '888888', account: 'other-org' },
                { id: ORG, account: 'acme' },
            ],
        });
        const pending = await beginOnboarding(app, '/tasks');
        const response = await finishOnboarding(app, pending, { orgs: [ORG] });
        expect(response.json().returnTo).toBe('/tasks');
    });
});

describe('the github_app_authorization webhook', () => {
    const SECRET = 'webhook-secret-for-the-installation-round-trip';
    const sign = (body: string) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
    const revocation = (action: string, senderId = 4242) =>
        JSON.stringify({ action, sender: { id: senderId, login: 'octocat' } });

    async function deliver(body: string, signature = sign(body)) {
        const memberGrants = memberGrantsFake();
        const config = testConfig({ auth: githubAuth(), webhookSecret: SECRET });
        const app = await buildApp({
            config,
            orgs: staticRegistry({ config, telemetry: stubTelemetryClient() }),
            auth: memoryAuthStore(),
            memberGrants,
        });
        const response = await app.inject({
            method: 'POST',
            url: '/api/github/webhook',
            payload: body,
            headers: {
                'content-type': 'application/json',
                'x-github-event': 'github_app_authorization',
                'x-hub-signature-256': signature,
            },
        });
        await app.close();
        return { response, memberGrants };
    }

    it('breaks every grant of the account the sender names when the authorization is revoked', async () => {
        const { response, memberGrants } = await deliver(revocation('revoked'));
        expect(response.statusCode).toBe(HTTP_OK);
        expect(memberGrants.revoked).toEqual([{ forge: 'github', externalAccountId: '4242' }]);
    });

    it('ignores any other action', async () => {
        const { response, memberGrants } = await deliver(revocation('created'));
        expect(response.statusCode).toBe(HTTP_OK);
        expect(memberGrants.revoked).toEqual([]);
    });

    it('breaks nothing on a delivery that names no numeric sender', async () => {
        const { response, memberGrants } = await deliver(JSON.stringify({ action: 'revoked', sender: {} }));
        expect(response.statusCode).toBe(HTTP_OK);
        expect(memberGrants.revoked).toEqual([]);
    });

    it('breaks nothing on a forged signature', async () => {
        const body = revocation('revoked');
        const { response, memberGrants } = await deliver(body, 'sha256=00');
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
        expect(memberGrants.revoked).toEqual([]);
    });
});
