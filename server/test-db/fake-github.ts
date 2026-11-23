import { type FakeForge, type ForgeCall, startFakeForge, USER_TOKEN_TTL_S } from './fake-forge.js';

export { USER_TOKEN_TTL_S };

export interface UserTokenPair {
    access_token: string;
    refresh_token: string;
    expires_in: number;
}
/** One pull request as the fake's `/_control/pulls` lists it. */
export interface FakePull {
    number: number;
    html_url: string;
    state: string;
    merged: boolean;
    draft: boolean;
    title: string;
    body: string;
    head: { ref: string; label: string };
    base: { ref: string };
    createdBy: string;
}

/** The fake GitHub (`scripts/fake-forge/github.mjs`) on a free port: the user-token flow, installation tokens, PRs and the call log. */
export const startFakeGithub = async ({ now }: { now?: () => number } = {}) => {
    const fake: FakeForge = await startFakeForge(now ? { now } : {});
    const { send } = fake;

    /** The sign-in round trip: authorize → code → a `ghu_`/`ghr_` pair. */
    const signIn = async (): Promise<UserTokenPair> => {
        const authorize = await send('GET', '/login/oauth/authorize?redirect_uri=http://board.test/cb&state=s1');
        const code = new URL(authorize.location as string).searchParams.get('code') as string;
        const exchanged = await send('POST', '/login/oauth/access_token', {
            body: { grant_type: 'authorization_code', code },
        });
        return exchanged.body as UserTokenPair;
    };
    return {
        ...fake,
        signIn,
        /** A fresh installation token (`ghs_…`), the bot's. */
        installationToken: async (): Promise<string> => (await fake.control('installation-token')).body.token,
        pulls: async (): Promise<FakePull[]> => (await fake.read('pulls')).body,
        calls: (): ForgeCall[] => fake.forge.calls(),
        /** Whether a member's user token may write pull requests; off, its create and edit answer 404. */
        writeAccess: (user: boolean) => fake.control('write-access', { user }),
    };
};
export type FakeGithub = Awaited<ReturnType<typeof startFakeGithub>>;
