import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createJiraHooks, jiraSiteHost } from '../src/integrations/providers/jira.js';
import {
    FAKE_ACCESS_TOKEN,
    FAKE_ACCOUNT_ID,
    FAKE_CLOUD_ID,
    FAKE_CODE,
    FAKE_REFRESH_TOKEN,
    FAKE_SITE_HOST,
    type FakeAtlassian,
    fakeResource,
    startFakeAtlassian,
} from './fake-atlassian.js';

let fake: FakeAtlassian;
beforeAll(async () => {
    fake = await startFakeAtlassian();
});
afterEach(() => {
    vi.restoreAllMocks();
});
afterAll(async () => {
    await fake.close();
});

const CLIENT_SECRET = 'stub-client-secret-never-in-output';
const hooks = () =>
    createJiraHooks({
        clientId: 'stub-client-id',
        clientSecret: CLIENT_SECRET,
        authorizeUrl: fake.authorizeUrl,
        tokenUrl: fake.tokenUrl,
        apiOrigin: fake.origin,
    });
const live = () => new AbortController().signal;
const exchange = (signal: AbortSignal = live()) =>
    hooks().exchangeCode({ code: FAKE_CODE, redirectUri: 'https://board.example.test/cb', signal });
const TOKEN_ROUTE = /^\/oauth\/token$/;
const RESOURCES_ROUTE = /^\/oauth\/token\/accessible-resources$/;
const MYSELF_ROUTE = /\/myself$/;

describe('jira hooks: static facts', () => {
    it('declares rotating refresh tokens, no PKCE and no revocation', () => {
        const h = hooks();
        expect(h).toMatchObject({ id: 'jira', supportsPkce: false, rotatesRefreshToken: true, revokeScope: 'none' });
        expect(h.revoke).toBeUndefined();
    });

    it('authorizeUrl carries audience, prompt=consent, the scopes space-separated, state and redirect_uri', () => {
        const url = new URL(
            hooks().authorizeUrl({
                clientId: 'stub-client-id',
                redirectUri: 'https://board.example.test/api/integrations/jira/callback',
                scopes: ['read:jira-work', 'offline_access'],
                state: 'st-1',
            })
        );
        expect(`${url.origin}${url.pathname}`).toBe(fake.authorizeUrl);
        expect(Object.fromEntries(url.searchParams)).toEqual({
            audience: 'api.atlassian.com',
            client_id: 'stub-client-id',
            scope: 'read:jira-work offline_access',
            redirect_uri: 'https://board.example.test/api/integrations/jira/callback',
            state: 'st-1',
            response_type: 'code',
            prompt: 'consent',
        });
    });
});

describe('jira hooks: token exchange', () => {
    it('exchangeCode: 200 gives tokens with an expiry and the answered scope as authority', async () => {
        const before = Date.now();
        const r = await exchange();
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.tokens.accessToken).toBe(FAKE_ACCESS_TOKEN);
        expect(r.tokens.refreshToken).toBe(FAKE_REFRESH_TOKEN);
        expect(r.tokens.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000 - 1000);
        expect(r.tokens.authority).toEqual({ scopes: ['offline_access', 'read:jira-user', 'read:jira-work'] });
        const sent = fake.calls.filter((c) => TOKEN_ROUTE.test(c.path)).at(-1)?.body;
        expect(sent).toEqual({
            grant_type: 'authorization_code',
            client_id: 'stub-client-id',
            client_secret: CLIENT_SECRET,
            code: FAKE_CODE,
            redirect_uri: 'https://board.example.test/cb',
        });
    });

    it('classifies a refusal as definitive and everything unconfirmed as ambiguous or not-sent', async () => {
        fake.on('POST', TOKEN_ROUTE, () => ({ status: 400, json: { error: 'invalid_grant' } }));
        expect(await exchange()).toEqual({ ok: false, failure: 'definitive' });
        fake.on('POST', TOKEN_ROUTE, () => ({ status: 503, json: {} }));
        expect(await exchange()).toEqual({ ok: false, failure: 'ambiguous' });
        fake.on('POST', TOKEN_ROUTE, () => ({ status: 429, json: { error: 'rate_limited' } }));
        expect(await exchange()).toEqual({ ok: false, failure: 'ambiguous' });
        fake.on('POST', TOKEN_ROUTE, () => ({ status: 400, json: { error: 'something_new' } }));
        expect(await exchange()).toEqual({ ok: false, failure: 'ambiguous' });
        fake.on('POST', TOKEN_ROUTE, () => ({ drop: true }));
        expect(await exchange()).toEqual({ ok: false, failure: 'ambiguous' });
        fake.on('POST', TOKEN_ROUTE, () => ({ truncate: true }));
        expect(await exchange()).toEqual({ ok: false, failure: 'ambiguous' });
        for (const json of [
            {},
            { access_token: 'x' },
            { access_token: '', expires_in: 5 },
            { access_token: 'x', expires_in: -1 },
        ]) {
            fake.on('POST', TOKEN_ROUTE, () => ({ status: 200, json }));
            expect(await exchange()).toEqual({ ok: false, failure: 'ambiguous' });
        }
        fake.on('POST', TOKEN_ROUTE, () => ({ status: 200, text: 'not json' }));
        expect(await exchange()).toEqual({ ok: false, failure: 'ambiguous' });
    });

    it('a call aborted before dispatch is not-sent and reaches no server', async () => {
        const before = fake.calls.length;
        const controller = new AbortController();
        controller.abort();
        expect(await exchange(controller.signal)).toEqual({ ok: false, failure: 'not-sent' });
        expect(fake.calls).toHaveLength(before);
    });

    it('a call aborted after dispatch is ambiguous', async () => {
        fake.on('POST', TOKEN_ROUTE, () => ({ status: 200, json: {}, delayMs: 2000 }));
        const controller = new AbortController();
        const pending = exchange(controller.signal);
        setTimeout(() => controller.abort(), 50);
        expect(await pending).toEqual({ ok: false, failure: 'ambiguous' });
    });

    it('a missing refresh_token and scope are tolerated: null and no authority', async () => {
        fake.on('POST', TOKEN_ROUTE, () => ({ status: 200, json: { access_token: 'a1', expires_in: 60 } }));
        const r = await exchange();
        expect(r.ok && r.tokens.refreshToken).toBeNull();
        expect(r.ok && r.tokens.authority).toBeUndefined();
    });

    it('refresh posts the refresh_token grant with the client secret from config, never from input', async () => {
        fake.on('POST', TOKEN_ROUTE, () => ({
            status: 200,
            json: { access_token: 'a2', expires_in: 60, refresh_token: 'r2', scope: 'read:jira-work' },
        }));
        const r = await hooks().refresh({ refreshToken: 'old-refresh', signal: live() });
        expect(r.ok && r.tokens.refreshToken).toBe('r2');
        expect(fake.calls.filter((c) => TOKEN_ROUTE.test(c.path)).at(-1)?.body).toEqual({
            grant_type: 'refresh_token',
            client_id: 'stub-client-id',
            client_secret: CLIENT_SECRET,
            refresh_token: 'old-refresh',
        });
    });
});

describe('jira hooks: discoverIdentity', () => {
    const discover = () => hooks().discoverIdentity({ accessToken: FAKE_ACCESS_TOKEN, signal: live() });

    it('one site gives the account, its label (email else display name) and the cloud resource', async () => {
        fake.on('GET', RESOURCES_ROUTE, () => ({ status: 200, json: [fakeResource()] }));
        fake.on('GET', MYSELF_ROUTE, () => ({
            status: 200,
            json: { accountId: FAKE_ACCOUNT_ID, displayName: 'Stub Account A', emailAddress: 'stub-a@example.com' },
        }));
        expect(await discover()).toEqual({
            externalAccountId: FAKE_ACCOUNT_ID,
            label: 'stub-a@example.com',
            resources: [{ id: FAKE_CLOUD_ID, label: FAKE_SITE_HOST }],
            authority: { scopes: ['read:jira-user', 'read:jira-work'] },
        });
        const call = fake.calls.filter((c) => MYSELF_ROUTE.test(c.path)).at(-1);
        expect(call?.path).toBe(`/ex/jira/${FAKE_CLOUD_ID}/rest/api/3/myself`);
        expect(call?.authorization).toBe(`Bearer ${FAKE_ACCESS_TOKEN}`);
    });

    it('falls back to the display name, and two sites give two resources with the union of scopes', async () => {
        fake.on('GET', RESOURCES_ROUTE, () => ({
            status: 200,
            json: [
                fakeResource(),
                fakeResource({
                    id: 'cloud-stub-b',
                    url: 'https://Stub-Site-B.atlassian.net',
                    scopes: ['write:jira-work'],
                }),
            ],
        }));
        fake.on('GET', MYSELF_ROUTE, () => ({ status: 200, json: { accountId: 'acct', displayName: 'Stub Name' } }));
        const found = await discover();
        expect(found?.label).toBe('Stub Name');
        expect(found?.resources).toEqual([
            { id: FAKE_CLOUD_ID, label: FAKE_SITE_HOST },
            { id: 'cloud-stub-b', label: 'stub-site-b.atlassian.net' },
        ]);
        expect(found?.authority.scopes).toEqual(['read:jira-user', 'read:jira-work', 'write:jira-work']);
    });

    it.each([
        ['a malformed resource entry', () => ({ status: 200, json: [fakeResource(), { id: 'x' }] })],
        ['a non-atlassian host', () => ({ status: 200, json: [fakeResource({ url: 'https://evil.example.test' })] })],
        ['a non-https url', () => ({ status: 200, json: [fakeResource({ url: 'http://x.atlassian.net' })] })],
        ['an empty list', () => ({ status: 200, json: [] })],
        ['a non-array answer', () => ({ status: 200, json: { resources: [] } })],
        ['a non-2xx answer', () => ({ status: 500, json: [] })],
        ['a dropped response', () => ({ drop: true as const })],
    ])('%s is null, never "no sites"', async (_name, reply) => {
        fake.on('GET', RESOURCES_ROUTE, reply);
        fake.on('GET', MYSELF_ROUTE, () => ({ status: 200, json: { accountId: FAKE_ACCOUNT_ID } }));
        expect(await discover()).toBeNull();
    });

    it('a missing accountId or a failed /myself is null', async () => {
        fake.on('GET', RESOURCES_ROUTE, () => ({ status: 200, json: [fakeResource()] }));
        fake.on('GET', MYSELF_ROUTE, () => ({ status: 200, json: { displayName: 'no id' } }));
        expect(await discover()).toBeNull();
        fake.on('GET', MYSELF_ROUTE, () => ({ status: 401, json: {} }));
        expect(await discover()).toBeNull();
    });
});

describe('jira hooks: secrets stay out of output', () => {
    it('no token, code or client secret reaches the console on any failure path', async () => {
        const out: string[] = [];
        for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
            vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
                out.push(args.map(String).join(' '));
            });
        }
        for (const reply of [{ drop: true as const }, { status: 400, json: { error: 'invalid_grant' } }]) {
            fake.on('POST', TOKEN_ROUTE, () => reply);
            await exchange();
            await hooks().refresh({ refreshToken: FAKE_REFRESH_TOKEN, signal: live() });
        }
        fake.on('GET', RESOURCES_ROUTE, () => ({ drop: true }));
        await hooks().discoverIdentity({ accessToken: FAKE_ACCESS_TOKEN, signal: live() });
        const text = out.join('\n');
        for (const secret of [FAKE_ACCESS_TOKEN, FAKE_REFRESH_TOKEN, FAKE_CODE, CLIENT_SECRET]) {
            expect(text).not.toContain(secret);
        }
    });
});

describe('jiraSiteHost', () => {
    it('accepts a site host or url and refuses anything else', () => {
        expect(jiraSiteHost('Acme.atlassian.net')).toBe('acme.atlassian.net');
        expect(jiraSiteHost('https://acme.atlassian.net/')).toBe('acme.atlassian.net');
        expect(jiraSiteHost('evil.example.test')).toBeNull();
        expect(jiraSiteHost('acme.atlassian.net.evil.test')).toBeNull();
        expect(jiraSiteHost('')).toBeNull();
    });
});
