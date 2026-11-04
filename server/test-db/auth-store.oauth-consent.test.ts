import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { hashToken } from '../src/auth/session.js';
import { useTestDb } from './harness.js';
import { testOrg } from './fixtures.js';
import { buildWorld, pkceChallenge, REDIRECT, VERIFIER, type OAuthWorld } from './oauth-rig.js';

const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const db = useTestDb({ orgs: [ORG] });

let sql: Sql;
beforeAll(() => {
    if (enabled) sql = db.sql;
});

const start = async (w: OAuthWorld) => {
    const sessionHash = hashToken('session-a');
    const created = await w.store.createConsent({
        sessionHash,
        clientId: w.clientId,
        redirectUri: REDIRECT,
        resource: w.resource,
        scopes: ['read'],
        codeChallenge: pkceChallenge(VERIFIER),
        clientState: 'opaque',
    });
    return { sessionHash, ...created };
};

describe.skipIf(!enabled)('oauth consent transaction', () => {
    it('reads back what the authorize request recorded, by id', async () => {
        const w = await buildWorld(sql, ORG);
        const tx = await start(w);
        expect(await w.store.readConsent(tx.id)).toMatchObject({
            clientId: w.clientId,
            redirectUri: REDIRECT,
            resource: w.resource,
            scopes: ['read'],
            codeChallenge: pkceChallenge(VERIFIER),
            clientState: 'opaque',
        });
        expect(await w.store.readConsent('unknown')).toBeNull();
    });

    it('consumes once, only for the same session and CSRF token', async () => {
        const w = await buildWorld(sql, ORG);
        const tx = await start(w);

        expect(await w.store.consumeConsent({ id: tx.id, sessionHash: hashToken('other'), csrf: tx.csrf })).toBeNull();
        expect(await w.store.consumeConsent({ id: tx.id, sessionHash: tx.sessionHash, csrf: 'wrong' })).toBeNull();
        // Wrong attempts do not burn it.
        expect(await w.store.consumeConsent({ id: tx.id, sessionHash: tx.sessionHash, csrf: tx.csrf })).toMatchObject({
            clientId: w.clientId,
        });
        expect(await w.store.consumeConsent({ id: tx.id, sessionHash: tx.sessionHash, csrf: tx.csrf })).toBeNull();
        expect(await w.store.readConsent(tx.id)).toBeNull();
    });

    it('expires', async () => {
        const w = await buildWorld(sql, ORG);
        const tx = await start(w);
        w.clock.advance(601);
        expect(await w.store.readConsent(tx.id)).toBeNull();
        expect(await w.store.consumeConsent({ id: tx.id, sessionHash: tx.sessionHash, csrf: tx.csrf })).toBeNull();
    });
});
