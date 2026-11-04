import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { hashToken } from '../src/auth/session.js';
import { createOAuthStore } from '../src/auth/oauth-store.js';
import { useTestDb } from './harness.js';
import { testOrg } from './fixtures.js';
import { buildWorld, exchange, grant, okGrant, pkceChallenge, REDIRECT, VERIFIER, testClock } from './oauth-rig.js';

const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const db = useTestDb({ orgs: [ORG], max: 12 });

let sql: Sql;
beforeAll(() => {
    if (enabled) sql = db.sql;
});

/** Two store instances on one database: what two server replicas are. */
const twoInstances = async () => {
    const clock = testClock();
    const world = await buildWorld(sql, ORG, clock);
    const other = createOAuthStore({ sql, now: clock.now });
    return { world, a: world.store, b: other };
};

describe.skipIf(!enabled)('oauth concurrency', () => {
    it('lets exactly one of two simultaneous exchanges of a code win; the replay revokes the family', async () => {
        const { world, a, b } = await twoInstances();
        const { code } = await a.createCode({
            clientId: world.clientId,
            userId: world.caller.user.id,
            orgId: ORG,
            scopes: ['read'],
            codeChallenge: pkceChallenge(VERIFIER),
            resource: world.resource,
            redirectUri: REDIRECT,
        });

        const results = await Promise.all([exchange(world, code, {}, a), exchange(world, code, {}, b)]);

        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: 'invalid_grant' }]);
        // Pinned: the loser is a replay, so the winner's family does not survive either.
        const winner = okGrant(results.find((r) => r.ok)!);
        expect(await a.findAccessToken(hashToken(winner.accessToken))).toBeNull();
        const families = await sql`select count(*)::int as n from oauth_grant_family where revoked_at is null`;
        expect(families[0]!.n).toBe(0);
    });

    it('pins two simultaneous refreshes of one token: one wins, the other is reuse and the family is revoked', async () => {
        const { world, a, b } = await twoInstances();
        const first = okGrant(await grant(world));

        const results = await Promise.all([
            a.refresh({ refreshToken: first.refreshToken, clientId: world.clientId }),
            b.refresh({ refreshToken: first.refreshToken, clientId: world.clientId }),
        ]);

        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: 'invalid_grant' }]);
        const winner = okGrant(results.find((r) => r.ok)!);
        expect(await a.findAccessToken(hashToken(winner.accessToken))).toBeNull();
        expect(await a.refresh({ refreshToken: winner.refreshToken, clientId: world.clientId })).toEqual({
            ok: false,
            error: 'invalid_grant',
        });
    });

    it('leaves nothing usable when a refresh races a revoke, whichever lands first', async () => {
        const { world, a, b } = await twoInstances();
        for (let round = 0; round < 8; round += 1) {
            const first = okGrant(await grant(world));
            const [refreshed] = await Promise.all([
                a.refresh({ refreshToken: first.refreshToken, clientId: world.clientId }),
                b.revoke({ token: first.refreshToken, clientId: world.clientId }),
            ]);

            expect(await a.findAccessToken(hashToken(first.accessToken))).toBeNull();
            if (refreshed.ok) {
                expect(await a.findAccessToken(hashToken(refreshed.accessToken))).toBeNull();
                expect((await a.refresh({ refreshToken: refreshed.refreshToken, clientId: world.clientId })).ok).toBe(
                    false
                );
            }
        }
    });
});
