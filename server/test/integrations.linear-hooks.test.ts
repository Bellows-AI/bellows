import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLinearHooks, linearRegistration, linearWorkspaceKey } from '../src/integrations/providers/linear.js';

const API = 'https://api.linear.example.test';
const AUTHORIZE = 'https://linear.example.test/oauth/authorize';
const CLIENT_SECRET = 'stub-linear-secret-never-in-output';
const CFG = { clientId: 'stub-linear-id', clientSecret: CLIENT_SECRET, authorizeUrl: AUTHORIZE, apiOrigin: API };
const REDIRECT = 'https://board.example.test/api/integrations/linear/callback';

interface Call {
    url: string;
    init: RequestInit;
}

/** A fake fetch: each call is recorded and answered by `answer`, which may throw like a transport. */
function fakeFetch(answer: (call: Call) => Response | Promise<Response>) {
    const calls: Call[] = [];
    const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const call = { url: String(input), init };
        calls.push(call);
        return answer(call);
    });
    return { fn: fn as unknown as typeof fetch, calls };
}

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tokenAnswer = (extra: Record<string, unknown> = {}) =>
    json(200, {
        access_token: 'lin-access',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'lin-refresh-2',
        ...extra,
    });
const live = () => new AbortController().signal;
const formOf = (call: Call | undefined) => Object.fromEntries(new URLSearchParams(String(call?.init.body)));
const headerOf = (call: Call | undefined, name: string) => new Headers(call?.init.headers).get(name);

afterEach(() => {
    vi.restoreAllMocks();
});

describe('linear hooks: static facts', () => {
    it('declares PKCE, rotating refresh tokens and token revocation', () => {
        const h = createLinearHooks(CFG, fakeFetch(() => json(200, {})).fn);
        expect(h).toMatchObject({ id: 'linear', supportsPkce: true, rotatesRefreshToken: true, revokeScope: 'token' });
        expect(typeof h.revoke).toBe('function');
    });

    it('authorizeUrl carries comma-joined scopes, actor=user, prompt=consent and an S256 challenge', () => {
        const url = new URL(
            createLinearHooks(CFG, fakeFetch(() => json(200, {})).fn).authorizeUrl({
                clientId: 'stub-linear-id',
                redirectUri: REDIRECT,
                scopes: ['read', 'write'],
                state: 'st-1',
                codeChallenge: 'challenge-1',
            })
        );
        expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE);
        expect(Object.fromEntries(url.searchParams)).toEqual({
            client_id: 'stub-linear-id',
            redirect_uri: REDIRECT,
            response_type: 'code',
            scope: 'read,write',
            state: 'st-1',
            actor: 'user',
            prompt: 'consent',
            code_challenge: 'challenge-1',
            code_challenge_method: 'S256',
        });
    });
});

describe('linear hooks: token calls', () => {
    it('exchange posts a form body with the verifier and the client secret from config', async () => {
        const fake = fakeFetch(() => tokenAnswer({ scope: 'read write' }));
        const result = await createLinearHooks(CFG, fake.fn).exchangeCode({
            code: 'code-1',
            redirectUri: REDIRECT,
            codeVerifier: 'verifier-1',
            signal: live(),
        });
        expect(result).toMatchObject({
            ok: true,
            tokens: {
                accessToken: 'lin-access',
                refreshToken: 'lin-refresh-2',
                authority: { scopes: ['read', 'write'] },
            },
        });
        expect(fake.calls).toHaveLength(1);
        expect(fake.calls[0]?.url).toBe(`${API}/oauth/token`);
        expect(fake.calls[0]?.init).toMatchObject({ method: 'POST', redirect: 'manual' });
        expect(headerOf(fake.calls[0], 'content-type')).toBe('application/x-www-form-urlencoded');
        expect(formOf(fake.calls[0])).toEqual({
            grant_type: 'authorization_code',
            code: 'code-1',
            redirect_uri: REDIRECT,
            code_verifier: 'verifier-1',
            client_id: 'stub-linear-id',
            client_secret: CLIENT_SECRET,
        });
    });

    it('a refresh answer carrying a new refresh_token returns it', async () => {
        const fake = fakeFetch(() => tokenAnswer({ refresh_token: 'lin-refresh-3' }));
        const result = await createLinearHooks(CFG, fake.fn).refresh({ refreshToken: 'lin-refresh-2', signal: live() });
        expect(result).toMatchObject({ ok: true, tokens: { refreshToken: 'lin-refresh-3' } });
        expect(formOf(fake.calls[0])).toEqual({
            grant_type: 'refresh_token',
            refresh_token: 'lin-refresh-2',
            client_id: 'stub-linear-id',
            client_secret: CLIENT_SECRET,
        });
    });

    it('a scope given as a space or comma string or as an array parses; any other shape is ambiguous', async () => {
        const refreshWith = async (scope: unknown) =>
            createLinearHooks(CFG, fakeFetch(() => tokenAnswer({ scope })).fn).refresh({
                refreshToken: 'r',
                signal: live(),
            });
        for (const scope of ['write read', 'read,write', 'read, write', ['write', 'read']]) {
            expect(await refreshWith(scope)).toMatchObject({
                ok: true,
                tokens: { authority: { scopes: ['read', 'write'] } },
            });
        }
        for (const scope of [42, { read: true }, ['read', 7], null]) {
            expect(await refreshWith(scope)).toEqual({ ok: false, failure: 'ambiguous' });
        }
    });

    it('an invalid_grant 400 is definitive', async () => {
        const fake = fakeFetch(() => json(400, { error: 'invalid_grant' }));
        expect(await createLinearHooks(CFG, fake.fn).refresh({ refreshToken: 'r', signal: live() })).toEqual({
            ok: false,
            failure: 'definitive',
        });
    });

    it('a 5xx, a timeout, a truncated stream or a non-JSON answer is ambiguous', async () => {
        const truncated = () =>
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode('{"access_token":'));
                        controller.error(new Error('premature close'));
                    },
                }),
                { status: 200 }
            );
        const timeout = () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'));
        for (const answer of [
            () => json(503, { error: 'invalid_grant' }),
            timeout,
            truncated,
            () => new Response('<html>'),
        ]) {
            const result = await createLinearHooks(CFG, fakeFetch(answer).fn).refresh({
                refreshToken: 'r',
                signal: live(),
            });
            expect(result).toEqual({ ok: false, failure: 'ambiguous' });
        }
    });

    it('a 200 without an access token or with a bad expires_in is ambiguous: the code may be spent', async () => {
        for (const body of [{ expires_in: 3600 }, { access_token: 'a', expires_in: 0 }, { access_token: 'a' }]) {
            const result = await createLinearHooks(CFG, fakeFetch(() => json(200, body)).fn).refresh({
                refreshToken: 'r',
                signal: live(),
            });
            expect(result).toEqual({ ok: false, failure: 'ambiguous' });
        }
    });

    it('a call aborted before dispatch is not-sent and fetches nothing', async () => {
        const fake = fakeFetch(() => tokenAnswer());
        const controller = new AbortController();
        controller.abort();
        expect(await createLinearHooks(CFG, fake.fn).refresh({ refreshToken: 'r', signal: controller.signal })).toEqual(
            { ok: false, failure: 'not-sent' }
        );
        expect(fake.calls).toHaveLength(0);
    });
});

describe('linear hooks: discoverIdentity', () => {
    const viewer = {
        id: 'viewer-1',
        name: 'Lane Person',
        email: 'person@example.test',
        organization: { id: 'org-1', name: 'Lane Workspace', urlKey: 'lane-workspace' },
    };
    const discover = (answer: () => Response) => {
        const fake = fakeFetch(answer);
        return {
            fake,
            result: createLinearHooks(CFG, fake.fn).discoverIdentity({ accessToken: 'lin-access', signal: live() }),
        };
    };

    it('a full viewer gives the account, its email label and the workspace as the resource', async () => {
        const { fake, result } = discover(() => json(200, { data: { viewer } }));
        expect(await result).toEqual({
            externalAccountId: 'viewer-1',
            label: 'person@example.test',
            resources: [{ id: 'org-1', label: 'lane-workspace' }],
            authority: { scopes: ['read'] },
        });
        expect(fake.calls[0]?.url).toBe(`${API}/graphql`);
        expect(fake.calls[0]?.init).toMatchObject({ method: 'POST', redirect: 'manual' });
        expect(headerOf(fake.calls[0], 'authorization')).toBe('Bearer lin-access');
        expect(JSON.parse(String(fake.calls[0]?.init.body)).query).toContain(
            'viewer { id name email organization { id name urlKey } }'
        );
    });

    it('falls back to the name, then the id, for the label', async () => {
        const named = discover(() => json(200, { data: { viewer: { ...viewer, email: '' } } }));
        expect(await named.result).toMatchObject({ label: 'Lane Person' });
        const bare = discover(() => json(200, { data: { viewer: { ...viewer, email: null, name: null } } }));
        expect(await bare.result).toMatchObject({ label: 'viewer-1' });
    });

    it('is null on anything unconfirmed, never "no workspace"', async () => {
        const answers: (() => Response)[] = [
            () => json(200, { errors: [{ message: 'authentication failed' }], data: null }),
            () => json(200, { data: { viewer: { ...viewer, organization: { id: 'org-1', name: 'x' } } } }),
            () => json(200, { data: { viewer: { ...viewer, organization: { ...viewer.organization, id: '' } } } }),
            () =>
                json(200, {
                    data: { viewer: { ...viewer, organization: { ...viewer.organization, urlKey: 'Not A Key!' } } },
                }),
            () => json(200, { data: { viewer: { ...viewer, id: '' } } }),
            () => json(200, { data: { viewer: null } }),
            () => json(500, { data: { viewer } }),
            () => new Response('not json'),
        ];
        for (const answer of answers) expect(await discover(answer).result).toBeNull();
        expect(await discover(() => Promise.reject(new Error('reset')) as never).result).toBeNull();
    });
});

describe('linear hooks: revoke', () => {
    const revoke = (answer: (call: Call) => Response | Promise<Response>) => {
        const fake = fakeFetch(answer);
        return { fake, result: createLinearHooks(CFG, fake.fn).revoke?.({ token: 'lin-refresh-2', signal: live() }) };
    };

    it('posts token= as a form to the revoke endpoint; a 200 is revoked', async () => {
        const { fake, result } = revoke(() => new Response(null, { status: 200 }));
        expect(await result).toBe('revoked');
        expect(fake.calls[0]?.url).toBe(`${API}/oauth/revoke`);
        expect(fake.calls[0]?.init).toMatchObject({ method: 'POST', redirect: 'manual' });
        expect(headerOf(fake.calls[0], 'content-type')).toBe('application/x-www-form-urlencoded');
        expect(formOf(fake.calls[0])).toEqual({ token: 'lin-refresh-2' });
    });

    it('a 400 or a throw is failed', async () => {
        expect(await revoke(() => json(400, { error: 'invalid_token' })).result).toBe('failed');
        expect(await revoke(() => Promise.reject(new Error('reset'))).result).toBe('failed');
    });
});

describe('linear hooks: secrets stay out of output', () => {
    it('no token or client secret reaches the console on any failure path', async () => {
        const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
        for (const spy of spies) spy.mockImplementation(() => undefined);
        const failing = createLinearHooks(CFG, fakeFetch(() => Promise.reject(new Error('reset'))).fn);
        await failing.refresh({ refreshToken: 'lin-refresh-2', signal: live() });
        await failing.discoverIdentity({ accessToken: 'lin-access', signal: live() });
        await failing.revoke?.({ token: 'lin-refresh-2', signal: live() });
        const printed = spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join('\n');
        for (const secret of [CLIENT_SECRET, 'lin-refresh-2', 'lin-access']) expect(printed).not.toContain(secret);
    });
});

describe('linearWorkspaceKey', () => {
    it('normalizes a urlKey or a workspace URL and refuses anything else', () => {
        expect(linearWorkspaceKey('https://linear.app/Acme/')).toBe('acme');
        expect(linearWorkspaceKey('lane-workspace')).toBe('lane-workspace');
        for (const raw of ['', 'a b', '-lead', 'https://example.test/acme', 42, null, 'x'.repeat(65)]) {
            expect(linearWorkspaceKey(raw)).toBeNull();
        }
    });

    it('is the hooks siteOf', () => {
        expect(createLinearHooks(CFG, fakeFetch(() => json(200, {})).fn).siteOf?.('https://linear.app/Acme/')).toBe(
            'acme'
        );
    });
});

describe('linearRegistration: what the board reports as connectable', () => {
    it('reports Linear only when configured and the board has a callback origin', () => {
        expect(linearRegistration(CFG, 'https://board.example.test').configured).toEqual(['linear']);
        expect(linearRegistration(CFG, null).configured).toEqual([]);
        expect(linearRegistration(null, 'https://board.example.test').configured).toEqual([]);
    });

    it('asks for read, or read and write, and calls the GraphQL endpoint for any workspace', () => {
        const registry = linearRegistration(CFG, 'https://board.example.test');
        expect(registry.clients('linear')?.scopesFor('read')).toEqual(['read']);
        expect(registry.clients('linear')?.scopesFor('write')).toEqual(['read', 'write']);
        expect(registry.apiBaseOf('linear', 'org-1')).toBe(`${API}/graphql`);
        expect(linearRegistration(null, null).apiBaseOf('linear', 'org-1')).toBeNull();
        expect(linearRegistration(null, null).notConfiguredOf('linear')).toMatch(
            /LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET/
        );
    });
});
