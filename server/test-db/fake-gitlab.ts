import { GITLAB_CODE_TTL_S, GITLAB_TOKEN_TTL_S, startFakeForge } from './fake-forge.js';

export { GITLAB_CODE_TTL_S, GITLAB_TOKEN_TTL_S };

/** The OAuth application every helper call presents, registered at start with all the scopes the fake knows. */
export const FAKE_CLIENT = {
    clientId: 'fake-app',
    clientSecret: 'fake-secret',
    scopes: [
        'api',
        'read_api',
        'read_user',
        'read_repository',
        'write_repository',
        'read_registry',
        'write_registry',
        'openid',
        'profile',
        'email',
    ],
};
export const REDIRECT_URI = 'http://board.test/cb';
/** What a token request authenticates the client with. */
export const CLIENT_AUTH = { client_id: FAKE_CLIENT.clientId, client_secret: FAKE_CLIENT.clientSecret };

export interface TokenPair {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
    scope: string;
}

/** The fake GitLab (`scripts/fake-forge/gitlab.mjs`) on a free port, for the self-tests and any suite that needs a GitLab. */
export const startFakeGitlab = async ({ now, client = true }: { now?: () => number; client?: boolean } = {}) => {
    const fake = await startFakeForge(now ? { now } : {});
    const { send } = fake;
    // The fake's OAuth refuses every request until a client is registered; `client: false` leaves the registry empty.
    if (client) await fake.control('gitlab/oauth-clients', { ...FAKE_CLIENT, redirectUris: [REDIRECT_URI] });

    /** The sign-in round trip: authorize → code → token pair, as `login` (the fake's default member when omitted). */
    const signIn = async (login?: string, scope?: string): Promise<TokenPair> => {
        const query = new URLSearchParams({
            redirect_uri: REDIRECT_URI,
            response_type: 'code',
            state: 's1',
            client_id: FAKE_CLIENT.clientId,
        });
        if (login) query.set('login', login);
        if (scope) query.set('scope', scope);
        const authorize = await send('GET', `/oauth/authorize?${query}`);
        const code = new URL(authorize.location as string).searchParams.get('code') as string;
        const exchanged = await send('POST', '/oauth/token', {
            body: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, ...CLIENT_AUTH },
        });
        return exchanged.body as TokenPair;
    };
    const refresh = (token: string) =>
        send('POST', '/oauth/token', { body: { grant_type: 'refresh_token', refresh_token: token, ...CLIENT_AUTH } });

    const revoke = (token: string) => send('POST', '/oauth/revoke', { body: { token, ...CLIENT_AUTH } });

    return { ...fake, signIn, refresh, revoke };
};
export type FakeGitlab = Awaited<ReturnType<typeof startFakeGitlab>>;
