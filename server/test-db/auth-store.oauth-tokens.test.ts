import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { hashToken } from '../src/auth/session.js';
import { useTestDb } from './harness.js';
import { testOrg } from './fixtures.js';
import { buildWorld, grant, okGrant, type OAuthWorld } from './oauth-rig.js';

const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const OTHER_ORG = testOrg();
const db = useTestDb({ orgs: [ORG, OTHER_ORG] });

let sql: Sql;
beforeAll(() => {
    if (enabled) sql = db.sql;
});

const resolves = async (w: OAuthWorld, token: string) => (await w.store.findAccessToken(hashToken(token))) !== null;

describe.skipIf(!enabled)('oauth refresh', () => {
    it('rotates: a new pair for the same grant, the old refresh token spent', async () => {
        const w = await buildWorld(sql, ORG);
        const first = okGrant(await grant(w));
        const second = await w.store.refresh({ refreshToken: first.refreshToken, clientId: w.clientId });
        if (!second.ok) throw new Error(second.error);

        expect(second.refreshToken).not.toBe(first.refreshToken);
        expect(second.familyId).toBe(first.familyId);
        expect(await resolves(w, second.accessToken)).toBe(true);
        expect(second.scopes).toEqual(['read', 'write']);
    });

    it('revokes the whole family when a rotated refresh token is used again', async () => {
        const w = await buildWorld(sql, ORG);
        const first = okGrant(await grant(w));
        const second = await w.store.refresh({ refreshToken: first.refreshToken, clientId: w.clientId });
        if (!second.ok) throw new Error(second.error);

        expect(await w.store.refresh({ refreshToken: first.refreshToken, clientId: w.clientId })).toEqual({
            ok: false,
            error: 'invalid_grant',
        });

        expect(await resolves(w, second.accessToken)).toBe(false);
        expect(await w.store.refresh({ refreshToken: second.refreshToken, clientId: w.clientId })).toEqual({
            ok: false,
            error: 'invalid_grant',
        });
    });

    it('may narrow scopes, and the narrowing sticks', async () => {
        const w = await buildWorld(sql, ORG);
        const first = okGrant(await grant(w));
        const narrowed = await w.store.refresh({
            refreshToken: first.refreshToken,
            clientId: w.clientId,
            scopes: ['read'],
        });
        if (!narrowed.ok) throw new Error(narrowed.error);
        expect(narrowed.scopes).toEqual(['read']);
        expect((await w.store.findAccessToken(hashToken(narrowed.accessToken)))?.scopes).toEqual(['read']);

        expect(
            await w.store.refresh({
                refreshToken: narrowed.refreshToken,
                clientId: w.clientId,
                scopes: ['read', 'write'],
            })
        ).toEqual({ ok: false, error: 'invalid_scope' });
    });

    it('refuses to widen scope beyond the grant', async () => {
        const w = await buildWorld(sql, ORG);
        const first = okGrant(await grant(w, ['read']));
        expect(
            await w.store.refresh({ refreshToken: first.refreshToken, clientId: w.clientId, scopes: ['read', 'write'] })
        ).toEqual({
            ok: false,
            error: 'invalid_scope',
        });
        // A refused refresh spends nothing: the same token still works.
        expect((await w.store.refresh({ refreshToken: first.refreshToken, clientId: w.clientId })).ok).toBe(true);
    });

    it('refuses to swap the resource', async () => {
        const w = await buildWorld(sql, ORG);
        const first = okGrant(await grant(w));
        expect(
            await w.store.refresh({
                refreshToken: first.refreshToken,
                clientId: w.clientId,
                resource: 'https://other.example.test/api/mcp',
            })
        ).toEqual({ ok: false, error: 'invalid_target' });
    });

    it('refuses to swap the org', async () => {
        const w = await buildWorld(sql, ORG);
        const first = okGrant(await grant(w));
        expect(
            await w.store.refresh({ refreshToken: first.refreshToken, clientId: w.clientId, orgId: OTHER_ORG })
        ).toEqual({
            ok: false,
            error: 'invalid_grant',
        });
    });

    it('refuses another client, an unknown token and an expired one', async () => {
        const w = await buildWorld(sql, ORG);
        const first = okGrant(await grant(w));
        expect(await w.store.refresh({ refreshToken: first.refreshToken, clientId: 'other' })).toEqual({
            ok: false,
            error: 'invalid_grant',
        });
        expect(await w.store.refresh({ refreshToken: 'mrt_nope', clientId: w.clientId })).toEqual({
            ok: false,
            error: 'invalid_grant',
        });
        w.clock.advance(31 * 86400);
        expect(await w.store.refresh({ refreshToken: first.refreshToken, clientId: w.clientId })).toEqual({
            ok: false,
            error: 'invalid_grant',
        });
    });
});

describe.skipIf(!enabled)('oauth reach', () => {
    it('loses reach when the membership is deleted', async () => {
        const w = await buildWorld(sql, ORG);
        const tokens = okGrant(await grant(w));
        expect(await resolves(w, tokens.accessToken)).toBe(true);

        await sql`delete from org_membership where org_id = ${ORG} and user_id = ${w.caller.user.id}`;

        expect(await resolves(w, tokens.accessToken)).toBe(false);
    });
});

describe.skipIf(!enabled)('oauth revocation', () => {
    it('revoking a refresh token ends the whole family', async () => {
        const w = await buildWorld(sql, ORG);
        const tokens = okGrant(await grant(w));
        await w.store.revoke({ token: tokens.refreshToken, clientId: w.clientId });
        expect(await resolves(w, tokens.accessToken)).toBe(false);
        expect((await w.store.refresh({ refreshToken: tokens.refreshToken, clientId: w.clientId })).ok).toBe(false);
    });

    it('revoking an access token ends only that token', async () => {
        const w = await buildWorld(sql, ORG);
        const tokens = okGrant(await grant(w));
        await w.store.revoke({ token: tokens.accessToken, clientId: w.clientId });
        expect(await resolves(w, tokens.accessToken)).toBe(false);
        expect((await w.store.refresh({ refreshToken: tokens.refreshToken, clientId: w.clientId })).ok).toBe(true);
    });

    it('ignores a revocation from a client that does not own the token', async () => {
        const w = await buildWorld(sql, ORG);
        const tokens = okGrant(await grant(w));
        await w.store.revoke({ token: tokens.refreshToken, clientId: 'someone-else' });
        await w.store.revoke({ token: tokens.accessToken, clientId: 'someone-else' });
        expect(await resolves(w, tokens.accessToken)).toBe(true);
        expect((await w.store.refresh({ refreshToken: tokens.refreshToken, clientId: w.clientId })).ok).toBe(true);
    });

    it('answers an unknown token without error', async () => {
        const w = await buildWorld(sql, ORG);
        await expect(w.store.revoke({ token: 'mrt_nope', clientId: w.clientId })).resolves.toBeUndefined();
    });
});
