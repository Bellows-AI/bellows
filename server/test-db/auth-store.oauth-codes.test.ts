import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { hashToken } from '../src/auth/session.js';
import { useTestDb } from './harness.js';
import { testOrg } from './fixtures.js';
import {
    buildWorld,
    exchange,
    grant,
    okGrant,
    pkceChallenge,
    REDIRECT,
    VERIFIER,
    type OAuthWorld,
} from './oauth-rig.js';

const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const db = useTestDb({ orgs: [ORG] });

let sql: Sql;
let world: OAuthWorld;

beforeAll(() => {
    if (enabled) sql = db.sql;
});

const fresh = async () => {
    world = await buildWorld(sql, ORG);
    return world;
};

describe.skipIf(!enabled)('oauth authorization codes', () => {
    it('exchanges a code for an access and refresh token that resolve to the granting caller', async () => {
        const w = await fresh();
        const tokens = okGrant(await grant(w, ['read']));

        expect(tokens.accessToken).toMatch(/^mat_/);
        expect(tokens.refreshToken).toMatch(/^mrt_/);
        const resolved = await w.store.findAccessToken(hashToken(tokens.accessToken));
        expect(resolved).toMatchObject({
            user: { id: w.caller.user.id },
            org: { id: ORG },
            scopes: ['read'],
            clientId: w.clientId,
            resource: w.resource,
            familyId: tokens.familyId,
        });
        // Only hashes are stored.
        const raw =
            await sql`select count(*)::int as n from oauth_token where token_hash = ${Buffer.from(tokens.accessToken)}`;
        expect(raw[0]!.n).toBe(0);
    });

    it('answers an unknown token with null', async () => {
        const w = await fresh();
        expect(await w.store.findAccessToken(hashToken('mat_nope'))).toBeNull();
    });

    it('refuses an expired access token', async () => {
        const w = await fresh();
        const tokens = okGrant(await grant(w));
        w.clock.advance(3600 + 1);
        expect(await w.store.findAccessToken(hashToken(tokens.accessToken))).toBeNull();
    });

    it('refuses an access token once its family has expired', async () => {
        const w = await fresh();
        const tokens = okGrant(await grant(w));
        await sql`update oauth_grant_family set expires_at = ${new Date(w.clock.now().getTime() - 1000)}`;
        expect(await w.store.findAccessToken(hashToken(tokens.accessToken))).toBeNull();
    });

    it('refuses an unknown or expired code', async () => {
        const w = await fresh();
        expect(await exchange(w, 'nope')).toEqual({ ok: false, error: 'invalid_grant' });
        const { code } = await w.store.createCode({
            clientId: w.clientId,
            userId: w.caller.user.id,
            orgId: ORG,
            scopes: ['read'],
            codeChallenge: pkceChallenge(VERIFIER),
            resource: w.resource,
            redirectUri: REDIRECT,
        });
        w.clock.advance(61);
        expect(await exchange(w, code)).toEqual({ ok: false, error: 'invalid_grant' });
    });

    it.each([
        ['client', { clientId: 'someone-else' }],
        ['redirect uri', { redirectUri: 'https://evil.example.test/cb' }],
        ['resource', { resource: 'https://other.example.test/api/mcp' }],
        ['PKCE verifier', { codeVerifier: 'x'.repeat(48) }],
    ])('refuses a code presented with a different %s, and the code is burned', async (_name, override) => {
        const w = await fresh();
        const { code } = await w.store.createCode({
            clientId: w.clientId,
            userId: w.caller.user.id,
            orgId: ORG,
            scopes: ['read'],
            codeChallenge: pkceChallenge(VERIFIER),
            resource: w.resource,
            redirectUri: REDIRECT,
        });
        expect(await exchange(w, code, override)).toEqual({ ok: false, error: 'invalid_grant' });
        expect(await exchange(w, code)).toEqual({ ok: false, error: 'invalid_grant' });
    });

    it('consumes a code once: a replay is refused and revokes the family it created', async () => {
        const w = await fresh();
        const { code } = await w.store.createCode({
            clientId: w.clientId,
            userId: w.caller.user.id,
            orgId: ORG,
            scopes: ['read'],
            codeChallenge: pkceChallenge(VERIFIER),
            resource: w.resource,
            redirectUri: REDIRECT,
        });
        const tokens = okGrant(await exchange(w, code));
        expect(await w.store.findAccessToken(hashToken(tokens.accessToken))).not.toBeNull();

        expect(await exchange(w, code)).toEqual({ ok: false, error: 'invalid_grant' });

        expect(await w.store.findAccessToken(hashToken(tokens.accessToken))).toBeNull();
        expect(await w.store.refresh({ refreshToken: tokens.refreshToken, clientId: w.clientId })).toEqual({
            ok: false,
            error: 'invalid_grant',
        });
    });
});

describe.skipIf(!enabled)('oauth clients', () => {
    it('holds a CIMD client (URL id, cached metadata) and a DCR client', async () => {
        const w = await fresh();
        const fetchedAt = w.clock.now();
        await w.store.upsertClient({
            clientId: 'https://app.example.test/client.json',
            kind: 'cimd',
            name: 'Hosted',
            redirectUris: [REDIRECT],
            metadata: { client_name: 'Hosted' },
            fetchedAt,
        });
        expect(await w.store.findClient('https://app.example.test/client.json')).toMatchObject({
            kind: 'cimd',
            redirectUris: [REDIRECT],
            metadata: { client_name: 'Hosted' },
            fetchedAt,
        });
        expect(await w.store.findClient(w.clientId)).toMatchObject({ kind: 'dcr', fetchedAt: null });
        expect(await w.store.findClient('missing')).toBeNull();
    });

    it('never lets a DCR upsert overwrite a CIMD client', async () => {
        const w = await fresh();
        const id = 'https://app.example.test/keep.json';
        await w.store.upsertClient({
            clientId: id,
            kind: 'cimd',
            name: 'Hosted',
            redirectUris: [REDIRECT],
            fetchedAt: w.clock.now(),
        });
        await w.store.upsertClient({
            clientId: id,
            kind: 'dcr',
            name: 'Squatter',
            redirectUris: ['https://evil.example.test/cb'],
        });
        expect(await w.store.findClient(id)).toMatchObject({ kind: 'cimd', name: 'Hosted', redirectUris: [REDIRECT] });
    });

    it('refreshes a CIMD client in place when its metadata is fetched again', async () => {
        const w = await fresh();
        const id = 'https://app.example.test/c.json';
        const base = { clientId: id, kind: 'cimd' as const, name: 'A', redirectUris: [REDIRECT] };
        await w.store.upsertClient({ ...base, fetchedAt: w.clock.now() });
        w.clock.advance(10);
        await w.store.upsertClient({ ...base, name: 'B', fetchedAt: w.clock.now() });
        expect(await w.store.findClient(id)).toMatchObject({ name: 'B', fetchedAt: w.clock.now() });
    });

    it('refuses a CIMD client without a fetch time', async () => {
        const w = await fresh();
        await expect(
            w.store.upsertClient({
                clientId: 'https://x.example.test/c.json',
                kind: 'cimd',
                name: null,
                redirectUris: [REDIRECT],
            })
        ).rejects.toThrow();
    });

    it('expires an unused DCR client after 30 days, keeping one that has a grant', async () => {
        const w = await fresh();
        const used = w.clientId;
        okGrant(await grant(w));
        await w.store.upsertClient({ clientId: 'idle', kind: 'dcr', name: null, redirectUris: [REDIRECT] });
        w.clock.advance(29 * 86400);
        expect(await w.store.deleteUnusedClients()).toBe(0);
        w.clock.advance(2 * 86400);
        expect(await w.store.deleteUnusedClients()).toBe(1);
        expect(await w.store.findClient('idle')).toBeNull();
        expect(await w.store.findClient(used)).not.toBeNull();
    });

    it('expires an idle CIMD client by its last fetch, keeping one fetched since or one a parked sign-in names', async () => {
        const w = await fresh();
        const cimd = (name: string) => `https://${name}.example.test/c.json`;
        const store = async (name: string) =>
            w.store.upsertClient({
                clientId: cimd(name),
                kind: 'cimd',
                name: null,
                redirectUris: [REDIRECT],
                fetchedAt: w.clock.now(),
            });
        await store('idle');
        await store('parked');
        await store('refetched');
        await w.store.createPending({
            clientId: cimd('parked'),
            redirectUri: REDIRECT,
            resource: w.resource,
            scopes: ['factory:read'],
            codeChallenge: pkceChallenge(VERIFIER),
            ttlSeconds: 90 * 86400,
        });
        w.clock.advance(25 * 86400);
        await store('refetched');
        w.clock.advance(6 * 86400);
        // The world's own unused DCR client goes with it.
        expect(await w.store.deleteUnusedClients()).toBe(2);
        expect(await w.store.findClient(cimd('idle'))).toBeNull();
        expect(await w.store.findClient(cimd('parked'))).not.toBeNull();
        expect(await w.store.findClient(cimd('refetched'))).not.toBeNull();
    });
});
