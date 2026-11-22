import type { Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAuthStore } from '../src/auth/store.js';
import { createIntegrationRuntime } from '../src/integrations/integration-recovery.js';
import { createMemberForgeGrants, type MemberForgeGrants } from '../src/integrations/member-forge-grant.js';
import { createGitHubUserHooks, GITHUB_FORGE } from '../src/integrations/providers/github-user.js';
import { type FakeAtlassian, startFakeAtlassian } from '../test/fake-atlassian.js';
import { githubAuth, harness, oneInstallation, stubIdentityClient } from '../test/helpers.js';
import { begin, callback } from '../test/auth.oauth-fixtures.js';
import { randomGithubId, testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';
import { lineageHarness } from './integration-store-faults.js';

/**
 * The member's GitHub grant (BEL-528): the sign-in exchange stores it, a sign-in replaces it, a refresh is one call across
 * board replicas, `bad_refresh_token` breaks it and a 5xx does not, and the revoke webhook breaks it. The real runtime,
 * lineage and secret store are composed as main.ts composes them; the scripted GitHub token endpoint on 127.0.0.1 is the
 * only boundary faked. Two `replica()`s over one database are two board replicas.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const OTHER_ORG = testOrg();
const ALICE = testUser('grant-alice');
const BOB = testUser('grant-bob');
const db = useTestDb({ orgs: [ORG, OTHER_ORG], users: [ALICE, BOB], max: 14 });

const TOKEN_ROUTE = /^\/login\/oauth\/access_token$/;

let fake: FakeAtlassian;
beforeEach(async () => {
    if (enabled) fake = await startFakeAtlassian();
});
afterEach(async () => {
    if (enabled) await fake.close();
});

/** One board replica: its own runtime and secret store over the shared database, the real GitHub user hooks. */
function replica(sql: Sql = db.sql): MemberForgeGrants {
    const hooks = createGitHubUserHooks({
        clientId: 'client-1',
        clientSecret: 'client-secret-1',
        authorizeUrl: `${fake.origin}/login/oauth/authorize`,
        tokenUrl: `${fake.origin}/login/oauth/access_token`,
        userUrl: `${fake.origin}/user`,
    });
    const secrets = lineageHarness(sql).open();
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

const accountOf = (user: { githubUserId: number }): string => String(user.githubUserId);

/** What a sign-in hands over, expiring inside the refresh skew unless told otherwise. */
const pair = (tag: string, expiresIn = 1) => ({
    accessToken: `ghu_${tag}`,
    refreshToken: `ghr_${tag}`,
    expiresIn,
});

const store = (
    grants: MemberForgeGrants,
    user: typeof ALICE,
    tag: string,
    options: { expiresIn?: number; orgId?: string } = {}
) =>
    grants.store({
        orgId: options.orgId ?? ORG,
        userId: user.id,
        forge: GITHUB_FORGE,
        externalAccountId: accountOf(user),
        tokens: pair(tag, options.expiresIn),
    });

/** The token endpoint, counting every refresh; each refresh answers a NEW pair, as GitHub does. */
function scriptRefresh(
    reply: (call: number) => Parameters<FakeAtlassian['on']>[2] extends (...a: never[]) => infer R ? R : never
) {
    let calls = 0;
    fake.on('POST', TOKEN_ROUTE, () => {
        calls += 1;
        return reply(calls);
    });
    return () => calls;
}

const newPair = (n: number) => ({
    status: 200,
    json: {
        access_token: `ghu_refreshed_${n}`,
        expires_in: 28_800,
        refresh_token: `ghr_refreshed_${n}`,
        refresh_token_expires_in: 15_811_200,
        token_type: 'bearer',
    },
});

const grantRows = (user: { githubUserId: number }, orgId = ORG) =>
    db.sql<
        {
            id: string;
            org_id: string;
            principal_user_id: string;
            provider: string;
            external_account_id: string;
            status: string;
            secret_version: string | null;
            version: string;
            lineage_claim: string | null;
        }[]
    >`
        select id, org_id, principal_user_id, provider, external_account_id, status, secret_version, version, lineage_claim
        from integration_grant where org_id = ${orgId} and external_account_id = ${accountOf(user)} order by created_at
    `;

describe.skipIf(!enabled)('the sign-in exchange stores the member’s GitHub grant', () => {
    /** The real app over the real auth store, the real grant store, and a scripted identity. */
    async function board() {
        const identity = stubIdentityClient({ githubUserId: randomGithubId(), login: 'grant-signer' });
        identity.installationsAnswer = oneInstallation(ORG);
        const memberGrants = replica();
        const { app } = await harness({
            config: { auth: githubAuth() },
            auth: createAuthStore({ sql: db.sql }),
            identity,
            memberGrants,
        });
        const signInWith = async (code: string) => {
            const state = await begin(app);
            return callback(app, `code=${code}&state=${encodeURIComponent(state)}`, state);
        };
        return { app, identity, memberGrants, signInWith };
    }

    it('keeps an active grant for the signed-in member in the signed-in org, with the token in the secret store', async () => {
        const { identity, memberGrants, signInWith } = await board();

        const response = await signInWith('first');
        expect(response.headers.location).toBe('/');

        const [member] = await db.sql<{ id: string }[]>`
            select id from app_user where github_user_id = ${identity.next.githubUserId}
        `;
        const rows = await grantRows(identity.next);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            org_id: ORG,
            principal_user_id: member!.id,
            provider: 'github',
            external_account_id: accountOf(identity.next),
            status: 'active',
        });
        expect(rows[0]!.secret_version).not.toBeNull();
        expect(await memberGrants.standing(ORG, member!.id, GITHUB_FORGE)).toBe('live');
        // The row names a reference only: the token itself is what the secret store hands back.
        expect(await memberGrants.accessToken(ORG, member!.id, GITHUB_FORGE)).toMatchObject({
            ok: true,
            accessToken: 'access-for-first',
        });
        expect(JSON.stringify(rows)).not.toContain('access-for-first');
    });

    it('a second sign-in replaces the grant: the same lineage, the new token', async () => {
        const { identity, memberGrants, signInWith } = await board();
        await signInWith('first');
        const [before] = await grantRows(identity.next);

        await signInWith('second');

        const rows = await grantRows(identity.next);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.id).toBe(before!.id);
        expect(Number(rows[0]!.version)).toBeGreaterThan(Number(before!.version));
        expect(rows[0]!.secret_version).not.toBe(before!.secret_version);
        expect(await memberGrants.accessToken(ORG, rows[0]!.principal_user_id, GITHUB_FORGE)).toMatchObject({
            ok: true,
            accessToken: 'access-for-second',
        });
    });

    it('a sign-in after the grant broke makes it live again: an active member never re-authorizes', async () => {
        const { identity, memberGrants, signInWith } = await board();
        await signInWith('first');
        const [row] = await grantRows(identity.next);
        await memberGrants.revokeAuthorization(GITHUB_FORGE, accountOf(identity.next));
        expect(await memberGrants.standing(ORG, row!.principal_user_id, GITHUB_FORGE)).toBe('broken');

        await signInWith('again');

        expect(await memberGrants.standing(ORG, row!.principal_user_id, GITHUB_FORGE)).toBe('live');
    });
});

describe.skipIf(!enabled)('standing', () => {
    it('is missing without a grant, and is not another member’s or another org’s', async () => {
        const grants = replica();
        expect(await grants.standing(ORG, ALICE.id, GITHUB_FORGE)).toBe('missing');
        await store(grants, ALICE, 'a');
        expect(await grants.standing(ORG, ALICE.id, GITHUB_FORGE)).toBe('live');
        expect(await grants.standing(ORG, BOB.id, GITHUB_FORGE)).toBe('missing');
        expect(await grants.standing(OTHER_ORG, ALICE.id, GITHUB_FORGE)).toBe('missing');
        expect(await grants.standing(ORG, ALICE.id, 'gitlab:example.test')).toBe('missing');
    });

    it('two replicas storing a first sign-in at once leave one grant', async () => {
        const [a, b] = [replica(), replica()];
        const [x, y] = await Promise.all([
            store(a, ALICE, 'x', { expiresIn: 28_800 }),
            store(b, ALICE, 'y', { expiresIn: 28_800 }),
        ]);
        expect([x.ok, y.ok].filter(Boolean).length).toBeGreaterThanOrEqual(1);
        const rows = await grantRows(ALICE);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.lineage_claim).toBeNull();
    });
});

describe.skipIf(!enabled)('the refresh is one call across replicas', () => {
    it('two replicas asking for an expiring token refresh once, and both then hold the new token', async () => {
        const [a, b] = [replica(), replica()];
        await store(a, ALICE, 'old');
        const refreshCalls = scriptRefresh((n) => ({ ...newPair(n), delayMs: 150 }));

        const first = await Promise.all([
            a.accessToken(ORG, ALICE.id, GITHUB_FORGE),
            b.accessToken(ORG, ALICE.id, GITHUB_FORGE),
        ]);
        // The one that lost the claim is told to retry; it never refreshes a second time.
        expect(refreshCalls()).toBe(1);
        expect(first.some((answer) => answer.ok)).toBe(true);

        const settled = await Promise.all([
            a.accessToken(ORG, ALICE.id, GITHUB_FORGE),
            b.accessToken(ORG, ALICE.id, GITHUB_FORGE),
        ]);
        expect(settled).toEqual([
            { ok: true, accessToken: 'ghu_refreshed_1', expiresAt: expect.any(Number) },
            { ok: true, accessToken: 'ghu_refreshed_1', expiresAt: expect.any(Number) },
        ]);
        expect(refreshCalls()).toBe(1);
    });

    it('spends the rotated refresh token on the next refresh, never the old one', async () => {
        const grants = replica();
        await store(grants, ALICE, 'old');
        const seen: string[] = [];
        fake.on('POST', TOKEN_ROUTE, (call, n) => {
            seen.push((call.body as { refresh_token: string }).refresh_token);
            return { ...newPair(n), json: { ...newPair(n).json, expires_in: 1 } };
        });

        await grants.accessToken(ORG, ALICE.id, GITHUB_FORGE);
        await grants.accessToken(ORG, ALICE.id, GITHUB_FORGE);

        expect(seen).toEqual(['ghr_old', 'ghr_refreshed_1']);
    });
});

describe.skipIf(!enabled)('broken versus inconclusive', () => {
    it('bad_refresh_token marks the grant broken, and the member is asked to reconnect', async () => {
        const grants = replica();
        await store(grants, ALICE, 'old');
        scriptRefresh(() => ({ status: 200, json: { error: 'bad_refresh_token' } }));

        const answer = await grants.accessToken(ORG, ALICE.id, GITHUB_FORGE);

        expect(answer).toEqual({
            ok: false,
            outcome: { outcome: 'integration_required', reason: 'reconnect', provider: 'github' },
        });
        expect(await grants.standing(ORG, ALICE.id, GITHUB_FORGE)).toBe('broken');
        expect((await grantRows(ALICE))[0]!.status).toBe('reconnect_required');
    });

    it('a 5xx never marks it broken: the grant stays active and the next refresh succeeds', async () => {
        const grants = replica();
        await store(grants, ALICE, 'old');
        const refreshCalls = scriptRefresh((n) =>
            n === 1 ? { status: 502, json: { message: 'bad gateway' } } : newPair(n)
        );

        const first = await grants.accessToken(ORG, ALICE.id, GITHUB_FORGE);

        expect(first.ok).toBe(false);
        expect(first).toMatchObject({ outcome: { outcome: 'unavailable', retryable: true } });
        expect(await grants.standing(ORG, ALICE.id, GITHUB_FORGE)).toBe('live');
        const [row] = await grantRows(ALICE);
        expect(row!.status).toBe('active');
        expect(row!.lineage_claim).toBeNull();

        expect(await grants.accessToken(ORG, ALICE.id, GITHUB_FORGE)).toMatchObject({
            ok: true,
            accessToken: 'ghu_refreshed_2',
        });
        expect(refreshCalls()).toBe(2);
    });

    it('a transport failure never marks it broken either', async () => {
        const grants = replica();
        await store(grants, ALICE, 'old');
        scriptRefresh(() => ({ drop: true }) as never);

        const answer = await grants.accessToken(ORG, ALICE.id, GITHUB_FORGE);

        expect(answer.ok).toBe(false);
        expect(await grants.standing(ORG, ALICE.id, GITHUB_FORGE)).toBe('live');
    });
});
