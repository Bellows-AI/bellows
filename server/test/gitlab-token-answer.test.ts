import { describe, expect, it } from 'vitest';
import type { GitlabApi, GitlabRequest, GitlabResponse } from '../src/gitlab/gitlab-api.js';
import { createGitlabProvider } from '../src/integrations/providers/gitlab.js';

/**
 * GitLab's token answers, strictly (docs/gitlab.md): it rotates the refresh token on every use, so a 2xx without a
 * usable replacement is not a success; it is `ambiguous`, which the lineage ends in reconnect-needed. The code
 * exchange needs the same refresh token to store a grant at all.
 */
const FORGE = 'gitlab:git.example.test';
const SENT = 'glrt-sent';
const GOOD = {
    access_token: 'gloas-new',
    refresh_token: 'glrt-new',
    expires_in: 7200,
    token_type: 'Bearer',
    scope: 'api',
};

const hooksAnswering = (body: unknown, status = 200) => {
    const api = {
        request: async (_req: GitlabRequest): Promise<GitlabResponse> => ({
            ok: true,
            status,
            text: typeof body === 'string' ? body : JSON.stringify(body),
        }),
    } as unknown as GitlabApi;
    const provider = createGitlabProvider({
        api,
        applicationOf: async () => ({
            connectionId: 'c',
            host: 'git.example.test',
            clientId: 'id',
            clientSecret: 'secret',
            caBundle: undefined,
            active: true,
        }),
    });
    const hooks = provider.hooksFor('org', FORGE);
    if (!hooks) throw new Error('no hooks');
    const signal = AbortSignal.timeout(1000);
    return {
        refresh: () => hooks.refresh({ refreshToken: SENT, signal }),
        exchange: () =>
            hooks.exchangeCode({ code: 'c', redirectUri: 'http://board.test/cb', codeVerifier: 'v', signal }),
    };
};

const without = (field: string) => Object.fromEntries(Object.entries(GOOD).filter(([key]) => key !== field));
const AMBIGUOUS = { ok: false, failure: 'ambiguous' };

describe('GitLab token answers', () => {
    it('accepts a complete rotation, bearer in any case', async () => {
        for (const type of ['Bearer', 'bearer']) {
            const refreshed = await hooksAnswering({ ...GOOD, token_type: type }).refresh();
            expect(refreshed).toMatchObject({
                ok: true,
                tokens: { accessToken: 'gloas-new', refreshToken: 'glrt-new' },
            });
        }
    });

    it.each([
        ['a missing refresh token', without('refresh_token')],
        ['an empty refresh token', { ...GOOD, refresh_token: '' }],
        ['a non-string refresh token', { ...GOOD, refresh_token: 12 }],
        ['an unchanged refresh token', { ...GOOD, refresh_token: SENT }],
        ['a missing access token', without('access_token')],
        ['an empty access token', { ...GOOD, access_token: '' }],
        ['a missing expiry', without('expires_in')],
        ['a zero expiry', { ...GOOD, expires_in: 0 }],
        ['a string expiry', { ...GOOD, expires_in: '7200' }],
        ['a missing token type', without('token_type')],
        ['a token type that is not bearer', { ...GOOD, token_type: 'mac' }],
        ['a body that is not JSON', '<html>ok</html>'],
        ['a JSON array', []],
    ])('a refresh answered 200 with %s is ambiguous: the old token is spent', async (_name, body) => {
        expect(await hooksAnswering(body).refresh()).toEqual(AMBIGUOUS);
    });

    it.each([
        ['a missing refresh token', without('refresh_token')],
        ['an empty refresh token', { ...GOOD, refresh_token: '' }],
        ['a token type that is not bearer', { ...GOOD, token_type: 'mac' }],
        ['a missing access token', without('access_token')],
    ])('a code exchange answered 200 with %s stores no grant', async (_name, body) => {
        expect(await hooksAnswering(body).exchange()).toEqual(AMBIGUOUS);
    });

    it('accepts a complete code exchange', async () => {
        expect(await hooksAnswering(GOOD).exchange()).toMatchObject({ ok: true, tokens: { refreshToken: 'glrt-new' } });
    });
});
