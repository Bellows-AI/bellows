import { expect } from 'vitest';
import type { Sql } from 'postgres';
import { createIntegrationRuntime } from '../src/integrations/integration-recovery.js';
import { createMemberForgeGrants, type MemberForgeGrants } from '../src/integrations/member-forge-grant.js';
import { createGitHubUserHooks, GITHUB_FORGE } from '../src/integrations/providers/github-user.js';
import type { SecretStore } from '../src/secrets/secret-store.js';
import type { FakeGithub } from './fake-github.js';
import type { TestUser } from './harness.js';

/** The member-grant reader as main.ts composes it, over the fake GitHub's token endpoint: shared by the suites that spend a member's token. */
const TOKEN_PATH = '/login/oauth/access_token';

/** `tokenFetch` is read at each refresh, so a test may swap it after the reader is built. */
export function memberGrantsOver(rig: {
    sql: Sql;
    fake: FakeGithub;
    secrets: SecretStore;
    tokenFetch: () => typeof fetch;
}): MemberForgeGrants {
    const { sql, fake, secrets, tokenFetch } = rig;
    const hooks = createGitHubUserHooks(
        {
            clientId: 'client-1',
            clientSecret: 'client-secret-1',
            authorizeUrl: `${fake.base}/login/oauth/authorize`,
            tokenUrl: `${fake.base}${TOKEN_PATH}`,
            userUrl: `${fake.base}/user`,
        },
        (input, init) => tokenFetch()(input, init)
    );
    const runtime = createIntegrationRuntime({
        sql,
        crossOrgSql: sql,
        secrets,
        providers: (provider) => (provider === GITHUB_FORGE ? hooks : undefined),
        clients: () => undefined,
        callbackOrigin: null,
        timing: { retryDelayMs: 0 },
    });
    return createMemberForgeGrants({ sql, crossOrgSql: sql, secrets, lineageOf: runtime.lineageOf });
}

/** The member's sign-in through the fake: its pair becomes the stored grant. `expiresIn` short enough puts it inside the refresh skew. */
export async function signMemberIn(
    rig: { grants: MemberForgeGrants; fake: FakeGithub; orgId: string; user: TestUser },
    options: { expiresIn?: number; refreshToken?: string } = {}
) {
    const { grants, fake, orgId, user } = rig;
    const pair = await fake.signIn();
    const stored = await grants.store({
        orgId,
        userId: user.id,
        forge: GITHUB_FORGE,
        externalAccountId: String(user.githubUserId),
        tokens: {
            accessToken: pair.access_token,
            refreshToken: options.refreshToken ?? pair.refresh_token,
            expiresIn: options.expiresIn ?? pair.expires_in,
        },
    });
    expect(stored).toEqual({ ok: true });
    return pair;
}
