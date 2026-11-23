import { describe, expect, it } from 'vitest';
import { createGitHubUserHooks } from '../src/integrations/providers/github-user.js';

/**
 * The GitHub App user-authorization hooks: what the grant lineage refreshes a member's `ghr_` token through.
 * The token endpoint is a function here, never a network: GitHub answers every token error with a 200 and an `error`
 * field, which is the part of the contract most worth pinning.
 */

const TOKEN_URL = 'https://github.test/login/oauth/access_token';
const CLIENT_SECRET = 'stub-client-secret-never-in-output';
const live = () => new AbortController().signal;

type Answer = { status?: number; json?: unknown; text?: string } | Error;

function hooksOver(answer: Answer) {
    const requests: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
            url: String(input),
            body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
            headers: (init?.headers ?? {}) as Record<string, string>,
        });
        if (answer instanceof Error) throw answer;
        return new Response(answer.text ?? JSON.stringify(answer.json ?? {}), { status: answer.status ?? 200 });
    }) as typeof fetch;
    const hooks = createGitHubUserHooks(
        {
            clientId: 'stub-client-id',
            clientSecret: CLIENT_SECRET,
            authorizeUrl: 'https://github.test/login/oauth/authorize',
            tokenUrl: TOKEN_URL,
            userUrl: 'https://api.github.test/user',
        },
        fetchFn
    );
    return { hooks, requests };
}

const PAIR = {
    access_token: 'ghu_new',
    expires_in: 28_800,
    refresh_token: 'ghr_new',
    refresh_token_expires_in: 15_811_200,
};
const refresh = (answer: Answer) => hooksOver(answer).hooks.refresh({ refreshToken: 'ghr_old', signal: live() });

describe('github user hooks: static facts', () => {
    it('declares a rotating refresh token, no PKCE, no token revocation, and a transient failure that is retryable', () => {
        const { hooks } = hooksOver({});
        expect(hooks).toMatchObject({
            id: 'github',
            supportsPkce: false,
            rotatesRefreshToken: true,
            revokeScope: 'none',
            retryTransientRefresh: true,
        });
        expect(hooks.revoke).toBeUndefined();
    });
});

describe('github user hooks: refresh', () => {
    it('answers the new pair with an expiry and no scopes', async () => {
        const before = Date.now();
        const answered = await refresh({ json: PAIR });
        expect(answered.ok).toBe(true);
        if (!answered.ok) return;
        expect(answered.tokens).toMatchObject({ accessToken: 'ghu_new', refreshToken: 'ghr_new' });
        expect(answered.tokens.expiresAt).toBeGreaterThanOrEqual(before + 28_800_000);
        expect(answered.tokens.authority).toEqual({ scopes: [] });
    });

    it('sends the client credentials and the refresh token to the token URL, as JSON', async () => {
        const { hooks, requests } = hooksOver({ json: PAIR });
        await hooks.refresh({ refreshToken: 'ghr_old', signal: live() });
        expect(requests).toHaveLength(1);
        expect(requests[0]!.url).toBe(TOKEN_URL);
        expect(requests[0]!.body).toEqual({
            client_id: 'stub-client-id',
            client_secret: CLIENT_SECRET,
            grant_type: 'refresh_token',
            refresh_token: 'ghr_old',
        });
    });

    it.each(['bad_refresh_token', 'incorrect_client_credentials', 'expired_token'])(
        'a 200 carrying %s is a definitive refusal: the token will never work',
        async (error) => {
            expect(await refresh({ json: { error } })).toEqual({ ok: false, failure: 'definitive' });
        }
    );

    it.each([
        ['a 502', { status: 502, json: { message: 'bad gateway' } }],
        ['a 500 with an HTML body', { status: 500, text: '<html>boom</html>' }],
        ['a 200 that is not a token answer', { json: { unexpected: true } }],
        ['a 200 with an error GitHub does not name as final', { json: { error: 'temporarily_unavailable' } }],
        ['a 403 with no reason', { status: 403, json: {} }],
        ['a transport failure', new Error('socket hang up')],
    ] as [string, Answer][])('%s is unconfirmed, never a verdict', async (_name, answer) => {
        expect(await refresh(answer)).toEqual({ ok: false, failure: 'ambiguous' });
    });

    it('an aborted signal never reaches the network', async () => {
        const { hooks, requests } = hooksOver({ json: PAIR });
        const controller = new AbortController();
        controller.abort();
        expect(await hooks.refresh({ refreshToken: 'ghr_old', signal: controller.signal })).toEqual({
            ok: false,
            failure: 'not-sent',
        });
        expect(requests).toHaveLength(0);
    });

    it('never puts the client secret in a failure', async () => {
        const answered = await refresh({ status: 502, text: `echo ${CLIENT_SECRET}` });
        expect(JSON.stringify(answered)).not.toContain(CLIENT_SECRET);
    });
});

describe('github user hooks: identity', () => {
    it('discovers the account by its numeric id, labelled with the login', async () => {
        const { hooks } = hooksOver({ json: { id: 424242, login: 'octocat' } });
        expect(await hooks.discoverIdentity({ accessToken: 'ghu_x', signal: live() })).toEqual({
            externalAccountId: '424242',
            label: 'octocat',
            resources: [],
            authority: { scopes: [] },
        });
    });

    it('answers null on anything unconfirmed, never "no account"', async () => {
        expect(
            await hooksOver({ status: 401, json: {} }).hooks.discoverIdentity({ accessToken: 'x', signal: live() })
        ).toBe(null);
        expect(
            await hooksOver({ json: { login: 'no-id' } }).hooks.discoverIdentity({ accessToken: 'x', signal: live() })
        ).toBe(null);
    });
});
