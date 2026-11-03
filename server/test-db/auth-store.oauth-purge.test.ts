import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { hashToken } from '../src/auth/session.js';
import { useTestDb } from './harness.js';
import { testOrg } from './fixtures.js';
import { buildWorld, exchange, grant, okGrant, pkceChallenge, REDIRECT, VERIFIER } from './oauth-rig.js';

const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const db = useTestDb({ orgs: [ORG] });
const DAY = 86400;
const REFRESH_DAYS = 30;

let sql: Sql;
beforeAll(() => {
    if (enabled) sql = db.sql;
});

const count = async (table: string, clientId: string): Promise<number> => {
    const rows = await sql<{ n: string }[]>`select count(*) as n from ${sql(table)} where client_id = ${clientId}`;
    return Number(rows[0]?.n);
};

describe.skipIf(!enabled)('oauth purgeExpired', () => {
    it('keeps everything live or recently expired, then drops expired codes, consent transactions and families', async () => {
        const w = await buildWorld(sql, ORG);
        const consent = () =>
            w.store.createConsent({
                sessionHash: hashToken('session'),
                clientId: w.clientId,
                redirectUri: REDIRECT,
                resource: w.resource,
                scopes: ['factory:read'],
                codeChallenge: pkceChallenge(VERIFIER),
            });
        const unspent = () =>
            w.store.createCode({
                clientId: w.clientId,
                userId: w.caller.user.id,
                orgId: ORG,
                scopes: ['factory:read'],
                codeChallenge: pkceChallenge(VERIFIER),
                resource: w.resource,
                redirectUri: REDIRECT,
            });
        const issued = okGrant(await grant(w, ['factory:read']));
        await consent();
        await unspent();

        // Expired an hour ago: inside the retention, so nothing goes yet.
        w.clock.advance(3600);
        expect(await w.store.purgeExpired()).toEqual({ codes: 0, consents: 0, families: 0 });

        // A day on: the unspent code and the consent transaction go; the grant is live for 30 days.
        w.clock.advance(2 * DAY);
        expect(await w.store.purgeExpired()).toEqual({ codes: 1, consents: 1, families: 0 });
        expect(await count('oauth_consent_transaction', w.clientId)).toBe(0);
        expect(await count('oauth_grant_family', w.clientId)).toBe(1);

        // Past the family's own expiry plus the retention, the grant, its tokens and its spent code go together.
        w.clock.advance(REFRESH_DAYS * DAY);
        expect(await w.store.purgeExpired()).toEqual({ codes: 0, consents: 0, families: 1 });
        expect(await count('oauth_authorization_code', w.clientId)).toBe(0);
        expect(await count('oauth_grant_family', w.clientId)).toBe(0);
        const tokens = await sql`select 1 from oauth_token where token_hash = ${hashToken(issued.accessToken)}`;
        expect(tokens).toHaveLength(0);
        expect(await w.store.purgeExpired()).toEqual({ codes: 0, consents: 0, families: 0 });
    });

    it('never touches a live grant, a live code or a live consent transaction', async () => {
        const w = await buildWorld(sql, ORG);
        const issued = okGrant(await grant(w, ['factory:read']));
        const { code } = await w.store.createCode({
            clientId: w.clientId,
            userId: w.caller.user.id,
            orgId: ORG,
            scopes: ['factory:read'],
            codeChallenge: pkceChallenge(VERIFIER),
            resource: w.resource,
            redirectUri: REDIRECT,
        });
        await w.store.createConsent({
            sessionHash: hashToken('session'),
            clientId: w.clientId,
            redirectUri: REDIRECT,
            resource: w.resource,
            scopes: ['factory:read'],
            codeChallenge: pkceChallenge(VERIFIER),
        });
        expect(await w.store.purgeExpired()).toEqual({ codes: 0, consents: 0, families: 0 });
        expect(await w.store.findAccessToken(hashToken(issued.accessToken))).not.toBeNull();
        expect(okGrant(await exchange(w, code)).accessToken).toBeTruthy();
    });
});
