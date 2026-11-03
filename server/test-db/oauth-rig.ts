import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { createAuthStore, type Caller } from '../src/auth/store.js';
import { createOAuthStore, type OAuthStore, type TokenGrant } from '../src/auth/oauth-store.js';
import { randomGithubId, testOrg } from './fixtures.js';

/** A mutable clock the store reads, so expiry is exercised without sleeping. */
export interface TestClock {
    at: Date;
    now: () => Date;
    advance: (seconds: number) => void;
}

export const testClock = (): TestClock => {
    const clock: TestClock = {
        at: new Date(),
        now: () => clock.at,
        advance: (seconds) => {
            clock.at = new Date(clock.at.getTime() + seconds * 1000);
        },
    };
    return clock;
};

export const pkceChallenge = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

export const VERIFIER = 'v'.repeat(48);
export const REDIRECT = 'https://client.example.test/callback';

/** One org, one member, one registered client: the smallest world an OAuth grant lives in. */
export interface OAuthWorld {
    orgId: string;
    caller: Caller;
    clientId: string;
    resource: string;
    store: OAuthStore;
    clock: TestClock;
}

export const buildWorld = async (sql: Sql, orgId: string, clock: TestClock = testClock()): Promise<OAuthWorld> => {
    const caller = await createAuthStore({ sql }).signIn(
        { githubUserId: randomGithubId(), login: `oauth-${orgId}`, displayName: null, avatarUrl: null },
        orgId,
        [{ id: orgId, name: orgId }]
    );
    const store = createOAuthStore({ sql, now: clock.now });
    const clientId = `client-${testOrg()}`;
    await store.upsertClient({ clientId, kind: 'dcr', name: 'Test client', redirectUris: [REDIRECT] });
    return { orgId, caller, clientId, resource: 'https://board.example.test/api/mcp', store, clock };
};

/** Issues a code for the world's member and exchanges it. */
export const grant = async (world: OAuthWorld, scopes = ['read', 'write'], store = world.store) => {
    const { code } = await store.createCode({
        clientId: world.clientId,
        userId: world.caller.user.id,
        orgId: world.orgId,
        scopes,
        codeChallenge: pkceChallenge(VERIFIER),
        resource: world.resource,
        redirectUri: REDIRECT,
    });
    return exchange(world, code, {}, store);
};

export const exchange = (
    world: OAuthWorld,
    code: string,
    override: Partial<Parameters<OAuthStore['consumeCode']>[0]> = {},
    store = world.store
) =>
    store.consumeCode({
        code,
        clientId: world.clientId,
        redirectUri: REDIRECT,
        resource: world.resource,
        codeVerifier: VERIFIER,
        ...override,
    });

export const okGrant = (result: Awaited<ReturnType<typeof exchange>>): TokenGrant => {
    if (!result.ok) throw new Error(`expected a grant, got ${result.error}`);
    return result;
};
