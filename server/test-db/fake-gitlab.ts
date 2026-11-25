import { GITLAB_CODE_TTL_S, GITLAB_TOKEN_TTL_S, startFakeForge } from './fake-forge.js';

export { GITLAB_CODE_TTL_S, GITLAB_TOKEN_TTL_S };

export interface TokenPair {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
}

/** The fake GitLab (`scripts/fake-forge/gitlab.mjs`) on a free port, for the self-tests and any suite that needs a GitLab. */
export const startFakeGitlab = async ({ now }: { now?: () => number } = {}) => {
    const fake = await startFakeForge(now ? { now } : {});
    const { send } = fake;

    /** The sign-in round trip: authorize → code → token pair, as `login` (the fake's default member when omitted). */
    const signIn = async (login?: string): Promise<TokenPair> => {
        const query = new URLSearchParams({ redirect_uri: 'http://board.test/cb', response_type: 'code', state: 's1' });
        if (login) query.set('login', login);
        const authorize = await send('GET', `/oauth/authorize?${query}`);
        const code = new URL(authorize.location as string).searchParams.get('code') as string;
        const exchanged = await send('POST', '/oauth/token', {
            body: { grant_type: 'authorization_code', code, redirect_uri: 'http://board.test/cb' },
        });
        return exchanged.body as TokenPair;
    };
    const refresh = (token: string) =>
        send('POST', '/oauth/token', { body: { grant_type: 'refresh_token', refresh_token: token } });

    return { ...fake, signIn, refresh };
};
export type FakeGitlab = Awaited<ReturnType<typeof startFakeGitlab>>;
