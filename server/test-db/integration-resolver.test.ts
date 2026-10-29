import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createConnectionGrants, grantSecretIdentity } from '../src/db/connection-grants.js';
import { createConnectionStore } from '../src/db/connection-store.js';
import { createCredentialResolver } from '../src/integrations/credential-resolver.js';
import { encodeGrantPayload, type GrantPayload } from '../src/integrations/grant-credentials.js';
import { createGrantLineage } from '../src/integrations/grant-lineage.js';
import {
    contextOfExecution,
    contextOfService,
    contextOfSession,
    isTrustedContext,
    type TrustedIntegrationContext,
} from '../src/integrations/trusted-context.js';
import type { SecretRef, SecretStore } from '../src/secrets/secret-store.js';
import { createFakeOAuth } from '../test/integrations-fake-provider.js';
import { testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';
import {
    attachJira,
    bindConnections,
    lineageHarness,
    newRoot,
    seedGrantSecret,
    spied,
} from './integration-store-faults.js';

/** BEL-138: the resolver turns a frozen binding into a short-lived credential, or into a closed outcome. */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const ALICE = testUser('resolver-alice');
const BOB = testUser('resolver-bob');
const db = useTestDb({ orgs: [ORG], users: [ALICE, BOB], max: 8 });

const payload = (scopes: string[], over: Partial<GrantPayload> = {}): GrantPayload => ({
    accessToken: 'access-seed',
    accessExpiresAt: Date.now() + 3_600_000,
    refreshToken: 'refresh-0',
    authority: { scopes },
    ...over,
});

async function rig(
    options: { scopes?: string[]; payload?: Partial<GrantPayload>; store?: (s: SecretStore) => SecretStore } = {}
) {
    const sql = db.sql;
    const scopes = options.scopes ?? ['fake:read'];
    const grants = createConnectionGrants({ sql, orgId: ORG });
    const attached = await attachJira(grants, ALICE.id, {
        externalAccountId: `acct-${randomUUID()}`,
        cloudId: `cloud-${randomUUID()}`,
        scopes,
    });
    const h = lineageHarness(sql);
    const seed = await seedGrantSecret(sql, h.open(), attached.grant, payload(scopes, options.payload));
    const root = await newRoot(sql, ORG, ALICE.id);
    await bindConnections(sql, { orgId: ORG, rootJobId: root, userId: ALICE.id }, [attached.connectionId]);
    const spy = spied(options.store ? options.store(h.open()) : h.open());
    const fake = createFakeOAuth();
    const lineage = createGrantLineage({
        sql,
        orgId: ORG,
        secrets: spy.store,
        providers: (p) => (p === 'jira' ? fake.hooks : undefined),
        timing: { retryDelayMs: 0 },
    });
    const resolver = createCredentialResolver({ sql, orgId: ORG, secrets: spy.store, lineage });
    const ctx = contextOfExecution({ orgId: ORG, executionUserId: ALICE.id, jobId: randomUUID(), attempt: 1 });
    return {
        h,
        grant: attached.grant,
        connectionId: attached.connectionId,
        root,
        ref: seed.ref as SecretRef,
        version: seed.version,
        spy,
        fake,
        lineage,
        grants,
        resolve: (context: TrustedIntegrationContext = ctx, extra: { rootJobId?: string } = {}) =>
            resolver.resolveCredential(
                context,
                { rootJobId: extra.rootJobId ?? root, connectionId: attached.connectionId },
                {}
            ),
        ctx,
        scopes,
    };
}

const required = (reason: string) => ({
    ok: false,
    outcome: { outcome: 'integration_required', reason, provider: 'jira' },
});
const unavailable = (reason: string) => ({ ok: false, outcome: { outcome: 'unavailable', reason, retryable: true } });
const forbidden = (reason: string) => ({ ok: false, outcome: { outcome: 'forbidden', reason } });

describe.skipIf(!enabled)('credential resolver', () => {
    it('a live token resolves with the grant authority, and never the secret reference', async () => {
        const r = await rig();
        const result = await r.resolve();
        expect(result).toMatchObject({
            ok: true,
            credential: { accessToken: 'access-seed', authority: { scopes: ['fake:read'] } },
        });
        expect(JSON.stringify(result)).not.toContain(r.ref);
        expect(r.fake.refreshCalls).toBe(0);
    });

    it('disconnect blocks resolution immediately, with no secret read', async () => {
        const r = await rig();
        expect((await r.resolve()).ok).toBe(true);
        const reads = r.spy.log.reads;
        const store = createConnectionStore({ sql: db.sql, orgId: ORG });
        await store.disconnect(r.connectionId, { userId: ALICE.id });
        expect(await r.resolve()).toMatchObject(required('missing'));
        expect(r.spy.log.reads).toBe(reads);
    });

    it('a grant widened by re-consent does not silently broaden an earlier binding', async () => {
        const r = await rig();
        const claim = await r.lineage.claimLineage(r.grant.id, 'reconsent', { rotates: false });
        if (!claim.ok) throw new Error(claim.reason);
        const widened = payload(['fake:read', 'fake:write']);
        expect(await r.lineage.commitLineage(claim.claim, widened)).toMatchObject({ ok: true });

        const earlier = await r.resolve();
        expect(earlier).toEqual({ ok: false, outcome: { outcome: 'forbidden', reason: 'binding-ceiling-exceeded' } });
        expect(JSON.stringify(earlier)).not.toContain('access-seed');

        const later = await newRoot(db.sql, ORG, ALICE.id);
        await bindConnections(db.sql, { orgId: ORG, rootJobId: later, userId: ALICE.id }, [r.connectionId]);
        expect(await r.resolve(r.ctx, { rootJobId: later })).toMatchObject({
            ok: true,
            credential: { authority: { scopes: ['fake:read', 'fake:write'] } },
        });
    });

    it('a narrowed grant still issues; the credential carries the narrower authority', async () => {
        const r = await rig({ scopes: ['fake:read', 'fake:write'] });
        const claim = await r.lineage.claimLineage(r.grant.id, 'reconsent', { rotates: false });
        if (!claim.ok) throw new Error(claim.reason);
        await r.lineage.commitLineage(claim.claim, payload(['fake:read']));
        expect(await r.resolve()).toMatchObject({ ok: true, credential: { authority: { scopes: ['fake:read'] } } });
    });

    it('another user, and a service principal, are refused with closed reasons', async () => {
        const r = await rig();
        const bob = contextOfExecution({ orgId: ORG, executionUserId: BOB.id, jobId: randomUUID(), attempt: 1 });
        expect(await r.resolve(bob)).toEqual(forbidden('principal-mismatch'));
        const service = contextOfService({ orgId: ORG, serviceId: 'svc-1' });
        expect(await r.resolve(service)).toEqual(forbidden('service-principal-unsupported'));
        expect(r.spy.log.reads).toBe(0);
    });

    it('a session context resolves for its own user', async () => {
        const r = await rig();
        const session = contextOfSession({ user: { id: ALICE.id } }, ORG);
        expect((await r.resolve(session)).ok).toBe(true);
    });

    it('a grant swapped under a binding is a reconnect', async () => {
        const r = await rig();
        await db.sql`update job_connection_binding set grant_id = ${randomUUID()} where root_job_id = ${r.root}`;
        expect(await r.resolve()).toMatchObject(required('reconnect'));
    });

    it('a reconnect_required grant is a reconnect; a grant with no secret version is pending', async () => {
        const r = await rig();
        await db.sql`update integration_grant set status = 'reconnect_required' where id = ${r.grant.id}`;
        expect(await r.resolve()).toMatchObject(required('reconnect'));
        await db.sql`update integration_grant set status = 'active', secret_version = null where id = ${r.grant.id}`;
        expect(await r.resolve()).toEqual(unavailable('credential-pending'));
    });

    it('a version mismatch, a malformed payload and a malformed authority are unavailable, never missing', async () => {
        const r = await rig();
        await db.sql`update integration_grant set secret_version = 'ver_other' where id = ${r.grant.id}`;
        expect(await r.resolve()).toEqual(unavailable('secret-unavailable'));
        await db.sql`update integration_grant set secret_version = ${r.version} where id = ${r.grant.id}`;
        await db.sql`update integration_grant set authority = '{"scopes":"all"}'::jsonb where id = ${r.grant.id}`;
        expect(await r.resolve()).toEqual(unavailable('secret-unavailable'));
        await db.sql`update integration_grant set authority = ${db.sql.json({ scopes: ['fake:read'] })} where id = ${r.grant.id}`;

        // A damaged payload decodes to nothing: integrity, not "empty".
        const broken = await rig({ payload: {} });
        const identity = grantSecretIdentity(broken.grant);
        const store = broken.h.open();
        const op = await store.issueOperationId();
        const replaced = await store.replace({
            identity,
            ref: broken.ref,
            operationId: op,
            expectedVersion: broken.version,
            payload: new TextEncoder().encode('not json'),
        });
        if (!replaced.ok) throw new Error('replace refused');
        await db.sql`update integration_grant set secret_version = ${replaced.version} where id = ${broken.grant.id}`;
        expect(await broken.resolve()).toEqual(unavailable('secret-unavailable'));
        expect(encodeGrantPayload(payload([])).length).toBeGreaterThan(0);
    });

    it('a disconnect during the parked exchange: the resolve never returns the token', async () => {
        const r = await rig({ payload: { accessExpiresAt: Date.now() - 60_000 } });
        const park = r.fake.parkNext();
        const pending = r.resolve();
        await park.accepted;
        const store = createConnectionStore({ sql: db.sql, orgId: ORG });
        await store.disconnect(r.connectionId, { userId: ALICE.id });
        park.release();
        const result = await pending;
        expect(result).toMatchObject(required('missing'));
        expect(JSON.stringify(result)).not.toContain('access-1');
    });

    it('TrustedIntegrationContext cannot be built from a plain object', async () => {
        const r = await rig();
        // @ts-expect-error a plain object is not a trusted context: the brand is module-private
        const forged: TrustedIntegrationContext = {
            orgId: ORG,
            principal: { kind: 'user', userId: ALICE.id },
            initiator: { kind: 'user', userId: ALICE.id },
        };
        expect(isTrustedContext(forged)).toBe(false);
        expect(isTrustedContext(r.ctx)).toBe(true);
        expect(await r.resolve(forged)).toEqual(forbidden('principal-mismatch'));
        expect(r.spy.log.reads).toBe(0);
    });
});
