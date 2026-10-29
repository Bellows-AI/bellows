import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    createConnectionGrants,
    grantSecretIdentity,
    readGrant,
    type IntegrationGrant,
} from '../src/db/connection-grants.js';
import { createConnectionStore } from '../src/db/connection-store.js';
import { createCredentialResolver } from '../src/integrations/credential-resolver.js';
import { encodeGrantPayload, type GrantPayload } from '../src/integrations/grant-credentials.js';
import { createGrantLineage, leaseMsOf, type LineageTiming } from '../src/integrations/grant-lineage.js';
import type { OAuthProviderHooks } from '../src/integrations/oauth-provider.js';
import { contextOfExecution } from '../src/integrations/trusted-context.js';
import type { SecretRef, SecretStore, SecretVersion } from '../src/secrets/secret-store.js';
import { createFakeOAuth, type FakeOAuth } from '../test/integrations-fake-provider.js';
import { useTestDb } from './harness.js';
import { testOrg, testUser } from './fixtures.js';
import {
    attachJira,
    bindConnections,
    faultyStore,
    lineageEvents,
    lineageHarness,
    parkBeforeStore,
    newRoot,
    parked,
    seedGrantSecret,
    spied,
    throwAfterActivate,
    throwBefore,
    ambiguousWrite,
} from './integration-store-faults.js';
import type { PostgresHarness } from './secrets-postgres-harness.js';

/** BEL-138: one grant is one refresh lineage; the claim, the identical replay and the recovery keep it single. */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const ALICE = testUser('lineage-alice');
const db = useTestDb({ orgs: [ORG], users: [ALICE], max: 12 });

const FAST: Partial<LineageTiming> = { retryDelayMs: 0 };
const expiredToken = () => Date.now() - 60_000;
const freshToken = () => Date.now() + 3_600_000;

interface Rig {
    h: PostgresHarness;
    secrets: SecretStore;
    fake: FakeOAuth;
    grant: IntegrationGrant;
    connections: string[];
    root: string;
    ref: SecretRef;
    seededVersion: SecretVersion;
}

async function rig(
    options: {
        rotates?: boolean;
        revokeScope?: 'token' | 'grant' | 'none';
        connections?: number;
        expired?: boolean;
        scopes?: string[];
        store?: (h: PostgresHarness) => SecretStore;
    } = {}
): Promise<Rig> {
    const sql = db.sql;
    const grants = createConnectionGrants({ sql, orgId: ORG });
    const fake = createFakeOAuth({ rotates: options.rotates ?? false, revokeScope: options.revokeScope ?? 'none' });
    const scopes = options.scopes ?? ['fake:read'];
    const acct = `acct-${randomUUID()}`;
    const attached: Awaited<ReturnType<typeof attachJira>>[] = [];
    for (let i = 0; i < (options.connections ?? 1); i += 1) {
        attached.push(
            await attachJira(grants, ALICE.id, { externalAccountId: acct, cloudId: `cloud-${randomUUID()}`, scopes })
        );
    }
    const grant = attached[0]!.grant;
    const h = lineageHarness(sql);
    const seed = await seedGrantSecret(sql, h.open(), grant, {
        accessToken: 'access-seed',
        accessExpiresAt: options.expired === false ? freshToken() : expiredToken(),
        refreshToken: fake.currentRefreshToken,
        authority: { scopes },
    });
    const root = await newRoot(sql, ORG, ALICE.id);
    const connections = attached.map((a) => a.connectionId);
    await bindConnections(sql, { orgId: ORG, rootJobId: root, userId: ALICE.id }, connections);
    const secrets = options.store ? options.store(h) : h.open();
    return { h, secrets, fake, grant, connections, root, ref: seed.ref as SecretRef, seededVersion: seed.version };
}

const replica = (
    r: Pick<Rig, 'fake'>,
    secrets: SecretStore,
    extra: { hooks?: OAuthProviderHooks; timing?: Partial<LineageTiming>; log?: (e: never) => void } = {}
) => {
    const lineage = createGrantLineage({
        sql: db.sql,
        orgId: ORG,
        secrets,
        providers: (provider) => (provider === 'jira' ? (extra.hooks ?? r.fake.hooks) : undefined),
        timing: { ...FAST, ...extra.timing },
        ...(extra.log ? { log: extra.log as never } : {}),
    });
    const resolver = createCredentialResolver({ sql: db.sql, orgId: ORG, secrets, lineage });
    return { lineage, resolver };
};

const ctx = () => contextOfExecution({ orgId: ORG, executionUserId: ALICE.id, jobId: randomUUID(), attempt: 1 });
const resolve = (resolver: ReturnType<typeof replica>['resolver'], r: Rig, index = 0, signal?: AbortSignal) =>
    resolver.resolveCredential(
        ctx(),
        { rootJobId: r.root, connectionId: r.connections[index]! },
        signal ? { signal } : {}
    );

interface LineageColumns {
    status: string;
    version: string;
    secret_ref: string | null;
    secret_version: string | null;
    authority: unknown;
    lineage_claim: string | null;
    lineage_claim_kind: string | null;
    lineage_operation_id: string | null;
    lineage_secret_ref: string | null;
    secret_wedged_at: Date | null;
    secret_destroyed_at: Date | null;
}
const columns = async (id: string): Promise<LineageColumns> =>
    (
        await db.sql<LineageColumns[]>`
            select status, version, secret_ref, secret_version, authority, lineage_claim, lineage_claim_kind,
                   lineage_operation_id, lineage_secret_ref, secret_wedged_at, secret_destroyed_at
            from integration_grant where id = ${id}
        `
    )[0]!;

const expireClaim = (id: string) =>
    db.sql`update integration_grant set lineage_claim_expires_at = now() - interval '1 second' where id = ${id}`;

const ok = <T extends { ok: boolean }>(value: T): Extract<T, { ok: true }> => {
    if (!value.ok) throw new Error(`expected ok, got ${JSON.stringify(value)}`);
    return value as Extract<T, { ok: true }>;
};

const tokenOf = (result: Awaited<ReturnType<typeof resolve>>): string => ok(result).credential.accessToken;

const activeOf = async (r: Rig, secrets: SecretStore = r.secrets) =>
    secrets.readActive({ identity: grantSecretIdentity(r.grant), ref: r.ref });

describe.skipIf(!enabled)('grant lineage: the lease invariant and the fault helper', () => {
    it('the lease outlasts the exchange plus the whole persistence budget plus a margin', () => {
        const timing = { exchangeDeadlineMs: 15_000, readDeadlineMs: 5_000, persistBudgetMs: 20_000, marginMs: 5_000 };
        expect(leaseMsOf({ ...timing, retryDelayMs: 100 })).toBeGreaterThanOrEqual(
            timing.exchangeDeadlineMs + timing.persistBudgetMs + timing.marginMs
        );
        const lineage = createGrantLineage({
            sql: db.sql,
            orgId: ORG,
            secrets: undefined as never,
            providers: () => undefined,
        });
        expect(lineage.leaseMs).toBe(leaseMsOf(lineage.timing));
    });

    it('the helper faults are the store’s own answers: outcome-unknown, an unknown operation, a finished delete', async () => {
        const r = await rig();
        const identity = grantSecretIdentity(r.grant);
        const never = faultyStore(r.h, { stageVersion: throwBefore(1) });
        const op = await never.store.issueOperationId();
        const payload = encodeGrantPayload({
            accessToken: 'a',
            accessExpiresAt: null,
            refreshToken: null,
            authority: { scopes: [] },
        });
        const first = await never.store.replace({
            identity,
            ref: r.ref,
            operationId: op,
            expectedVersion: r.seededVersion,
            payload,
        });
        expect(first).toEqual({ ok: false, error: { code: 'outcome-unknown', reason: 'provider-timeout' } });
        const reconciled = await r.h.open().reconcileOperation({ identity, ref: r.ref, operationId: op });
        expect(reconciled).toMatchObject({ ok: true, status: { state: 'unknown' } });
        // The identical replay resumes it: the payload that never staged is staged now.
        const replay = await never.store.replace({
            identity,
            ref: r.ref,
            operationId: op,
            expectedVersion: r.seededVersion,
            payload,
        });
        expect(replay.ok).toBe(true);

        const lost = faultyStore(r.h, { activate: throwAfterActivate });
        const next = await lost.store.issueOperationId();
        const version = (replay as { version: SecretVersion }).version;
        const deleted = await lost.store.delete({ identity, ref: r.ref, operationId: next, expectedVersion: version });
        expect(deleted).toEqual({ ok: false, error: { code: 'outcome-unknown', reason: 'provider-timeout' } });
        const after = await r.h.open().reconcileOperation({ identity, ref: r.ref, operationId: next });
        expect(after).toMatchObject({ ok: true, status: { state: 'succeeded', result: { version: null } } });
        expect(ambiguousWrite()).toBeInstanceOf(Error);
    });
});

describe.skipIf(!enabled)('grant lineage: one exchange per lineage', () => {
    it('two connections sharing a grant on two replicas: one exchange', async () => {
        const r = await rig({ connections: 2 });
        const a = replica(r, r.h.open());
        const b = replica(r, r.h.openWith(r.h.realRepo));
        const park = r.fake.parkNext();
        const first = resolve(a.resolver, r, 0);
        await park.accepted;
        expect(await resolve(b.resolver, r, 1)).toEqual({
            ok: false,
            outcome: { outcome: 'unavailable', reason: 'refresh-in-progress', retryable: true },
        });
        park.release();
        expect(tokenOf(await first)).toBe('access-1');
        expect(tokenOf(await resolve(b.resolver, r, 1))).toBe('access-1');
        expect(r.fake.refreshCalls).toBe(1);
        expect((await columns(r.grant.id)).version).toBe(String(r.grant.version + 1));
    });

    it('same replica: concurrent resolves coalesce into one exchange', async () => {
        const r = await rig({ connections: 2 });
        const events = lineageEvents();
        const a = replica(r, r.h.open(), { log: events.log });
        const park = r.fake.parkNext();
        const first = resolve(a.resolver, r, 0);
        await park.accepted;
        const second = resolve(a.resolver, r, 1);
        await events.occurred('refresh-joined');
        park.release();
        expect([tokenOf(await first), tokenOf(await second)]).toEqual(['access-1', 'access-1']);
        expect(r.fake.refreshCalls).toBe(1);
    });
});

describe.skipIf(!enabled)('grant lineage: refresh against disconnect', () => {
    it.each([
        ['token', ['refresh-1']],
        ['none', []],
    ] as const)(
        'disconnect settles while the exchange is parked; the late result is dropped and the secret destroyed (revoke %s)',
        async (revokeScope, revoked) => {
            const r = await rig({ rotates: true, revokeScope });
            const a = replica(r, r.h.open());
            const store = createConnectionStore({ sql: db.sql, orgId: ORG });
            const park = r.fake.parkNext();
            const pending = resolve(a.resolver, r);
            await park.accepted;
            // No database lock is held across the exchange: the disconnect commits before the release.
            expect(await store.disconnect(r.connections[0]!, { userId: ALICE.id, admin: false })).toEqual({
                disconnected: true,
                revokedGrantId: r.grant.id,
            });
            park.release();
            expect(await pending).toEqual({
                ok: false,
                outcome: { outcome: 'integration_required', reason: 'missing', provider: 'jira' },
            });
            const row = await columns(r.grant.id);
            expect(row.lineage_operation_id).toBeNull();
            expect(row.lineage_claim).toBeNull();
            expect(row.secret_version).toBe(r.seededVersion);
            expect(ok(await activeOf(r)).version).toBe(r.seededVersion);
            expect(r.fake.revoked.filter((t) => t.startsWith('refresh-1'))).toEqual([...revoked]);

            expect(await a.lineage.destroyRevokedSecret(r.grant.id)).toMatchObject({ ok: true });
            expect(await activeOf(r)).toMatchObject({ ok: false, error: { code: 'not-found' } });
        }
    );

    it('after persist: the finalize keeps revoked and the destroy deletes the new version', async () => {
        const hold = parked();
        const r = await rig({
            rotates: true,
            store: (h) =>
                faultyStore(h, {
                    activate: async (run, _call, [, origin]) => {
                        const result = await run();
                        if (origin === 'request') await hold.hold();
                        return result;
                    },
                }).store,
        });
        const a = replica(r, r.secrets);
        const store = createConnectionStore({ sql: db.sql, orgId: ORG });
        const pending = resolve(a.resolver, r);
        await hold.entered;
        expect((await store.disconnect(r.connections[0]!, { userId: ALICE.id, admin: false })).disconnected).toBe(true);
        hold.release();
        expect((await pending).ok).toBe(false);
        const row = await columns(r.grant.id);
        expect(row.status).toBe('revoked');
        expect(row.version).toBe(String(r.grant.version + 1));
        expect(row.secret_version).not.toBe(r.seededVersion);
        expect(row.lineage_claim).toBeNull();

        expect(await a.lineage.destroyRevokedSecret(r.grant.id)).toMatchObject({ ok: true });
        expect(await activeOf(r)).toMatchObject({ ok: false, error: { code: 'not-found' } });
        expect((await columns(r.grant.id)).secret_version).toBeNull();
    });
});

describe.skipIf(!enabled)('grant lineage: persistence faults', () => {
    it('lost response, applied: the holder’s identical replay finalizes in-process', async () => {
        const spy = { current: undefined as ReturnType<typeof spied> | undefined };
        const r = await rig({
            rotates: true,
            store: (h) => {
                spy.current = spied(faultyStore(h, { activate: throwAfterActivate }).store);
                return spy.current.store;
            },
        });
        const a = replica(r, r.secrets);
        expect(tokenOf(await resolve(a.resolver, r))).toBe('access-1');
        expect(r.fake.refreshCalls).toBe(1);
        expect(spy.current!.log.replaces).toBe(2);
        const row = await columns(r.grant.id);
        expect(row.version).toBe(String(r.grant.version + 1));
        expect(row.lineage_claim).toBeNull();
        expect(row.lineage_operation_id).toBeNull();
    });

    it('lost response, applied, holder crashed: the lease lapses and recovery finalizes without another exchange', async () => {
        const r = await rig({
            rotates: true,
            store: (h) => faultyStore(h, { activate: throwAfterActivate }).store,
        });
        const crashed = replica(r, r.secrets, { timing: { persistBudgetMs: 0 } });
        expect(await resolve(crashed.resolver, r)).toEqual({
            ok: false,
            outcome: { outcome: 'unavailable', reason: 'persistence-pending', retryable: true },
        });
        const pending = await columns(r.grant.id);
        expect(pending.lineage_claim).not.toBeNull();
        expect(pending.lineage_operation_id).not.toBeNull();
        await expireClaim(r.grant.id);

        const fresh = replica(r, r.h.openWith(r.h.realRepo));
        expect(await fresh.lineage.recoverLineage(r.grant.id)).toBe('finalized');
        expect(tokenOf(await resolve(fresh.resolver, r))).toBe('access-1');
        expect(r.fake.refreshCalls).toBe(1);
        expect((await columns(r.grant.id)).lineage_claim).toBeNull();
    });

    it('payload never staged, holder alive: the identical replay resumes the same operation', async () => {
        const spy = { current: undefined as ReturnType<typeof spied> | undefined };
        const r = await rig({
            rotates: true,
            store: (h) => {
                spy.current = spied(faultyStore(h, { stageVersion: throwBefore(1) }).store);
                return spy.current.store;
            },
        });
        const a = replica(r, r.secrets);
        expect(tokenOf(await resolve(a.resolver, r))).toBe('access-1');
        expect(r.fake.refreshCalls).toBe(1);
        expect(spy.current!.log.operationIds).toHaveLength(1);
        const reconciled = await r.h.open().reconcileOperation({
            identity: grantSecretIdentity(r.grant),
            ref: r.ref,
            operationId: spy.current!.log.operationIds[0] as never,
        });
        expect(reconciled).toMatchObject({ ok: true, status: { state: 'succeeded' } });
    });

    it('payload never staged, holder crashed: reconnect_required, the reference is wedged, a reconsent moves to a fresh one', async () => {
        const r = await rig({
            rotates: true,
            store: (h) => faultyStore(h, { stageVersion: throwBefore() }).store,
        });
        const events = lineageEvents();
        const crashed = replica(r, r.secrets, { timing: { persistBudgetMs: 0 }, log: events.log });
        expect(await resolve(crashed.resolver, r)).toMatchObject({
            ok: false,
            outcome: { reason: 'persistence-pending' },
        });
        await expireClaim(r.grant.id);

        const fresh = replica(r, r.h.openWith(r.h.realRepo), { log: events.log });
        expect(await fresh.lineage.recoverLineage(r.grant.id)).toBe('wedged');
        const wedged = await columns(r.grant.id);
        expect(wedged.status).toBe('reconnect_required');
        expect(wedged.secret_wedged_at).not.toBeNull();
        expect(wedged.lineage_claim).toBeNull();
        expect(wedged.lineage_operation_id).not.toBeNull();
        expect(r.fake.refreshCalls).toBe(1);
        expect(events.events.map((e) => e.event)).toContain('secret-wedged');
        expect(await resolve(fresh.resolver, r)).toMatchObject({ ok: false, outcome: { reason: 'reconnect' } });

        // The wedge is real: a fresh replace on that reference is refused while the unknown operation stands.
        const other = r.h.openWith(r.h.realRepo);
        expect(
            await other.replace({
                identity: grantSecretIdentity(r.grant),
                ref: r.ref,
                operationId: await other.issueOperationId(),
                expectedVersion: r.seededVersion,
                payload: new Uint8Array([1]),
            })
        ).toEqual({ ok: false, error: { code: 'conflict', reason: 'operation-pending' } });

        const claim = ok(await fresh.lineage.claimLineage(r.grant.id, 'reconsent', { rotates: true })).claim;
        const payload: GrantPayload = {
            accessToken: 'access-r',
            accessExpiresAt: freshToken(),
            refreshToken: 'refresh-r',
            authority: { scopes: ['fake:read'] },
        };
        expect(await fresh.lineage.commitLineage(claim, payload)).toMatchObject({ ok: true });
        const back = await columns(r.grant.id);
        expect(back.status).toBe('active');
        expect(back.secret_ref).not.toBe(r.ref);
        expect(back.secret_wedged_at).toBeNull();
        expect(back.lineage_operation_id).toBeNull();
        expect(back.version).toBe(String(r.grant.version + 1));
        expect(tokenOf(await resolve(fresh.resolver, r))).toBe('access-r');
    });

    it.each([
        ['rotating', true],
        ['non-rotating', false],
    ] as const)('op recorded but never reached the store (%s)', async (_label, rotates) => {
        const r = await rig({ rotates });
        const a = replica(r, r.secrets);
        const claim = ok(await a.lineage.claimLineage(r.grant.id, 'refresh', { rotates })).claim;
        const op = await r.secrets.issueOperationId();
        await db.sql`
            update integration_grant set lineage_operation_id = ${op}, lineage_secret_ref = secret_ref
            where id = ${r.grant.id} and lineage_claim = ${claim.token}
        `;
        await expireClaim(r.grant.id);
        expect(await a.lineage.recoverLineage(r.grant.id)).toBe(rotates ? 'reconnect-required' : 'released');
        const row = await columns(r.grant.id);
        expect(row.secret_wedged_at).toBeNull();
        expect(row.lineage_claim).toBeNull();
        expect(row.status).toBe(rotates ? 'reconnect_required' : 'active');
        expect(row.secret_version).toBe(r.seededVersion);
        expect(row.lineage_operation_id).toBeNull();
        expect(r.fake.refreshCalls).toBe(0);
    });

    it.each([
        ['an unavailable answer', ambiguousWrite as () => Error],
        ['a thrown bug', (() => new TypeError('a bug')) as () => Error],
    ])('recovery leaves a reconcile that is %s untouched', async (_label, error) => {
        const r = await rig({
            rotates: true,
            store: (h) =>
                faultyStore(h, {
                    findOperation: async () => {
                        throw error();
                    },
                }).store,
        });
        const a = replica(r, r.secrets);
        const claim = ok(await a.lineage.claimLineage(r.grant.id, 'refresh', { rotates: true })).claim;
        await db.sql`
            update integration_grant set lineage_operation_id = 'op-x', lineage_secret_ref = secret_ref
            where id = ${r.grant.id} and lineage_claim = ${claim.token}
        `;
        await expireClaim(r.grant.id);
        const before = await columns(r.grant.id);
        const result = await a.lineage.recoverLineage(r.grant.id).catch(() => 'threw');
        expect(['left', 'threw']).toContain(result);
        expect(await columns(r.grant.id)).toEqual(before);
        expect(r.fake.refreshCalls).toBe(0);
    });
});

describe.skipIf(!enabled)('grant lineage: destroy', () => {
    const revokedRig = async (store?: (h: PostgresHarness) => SecretStore) => {
        const r = await rig({ expired: false, ...(store ? { store } : {}) });
        const connections = createConnectionStore({ sql: db.sql, orgId: ORG });
        await connections.disconnect(r.connections[0]!, { userId: ALICE.id, admin: false });
        return r;
    };

    it('lost response: recovery dispatches on kind destroy and clears secret_version', async () => {
        const r = await revokedRig((h) => faultyStore(h, { activate: throwAfterActivate }).store);
        const before = await columns(r.grant.id);
        const crashed = replica(r, r.secrets, { timing: { persistBudgetMs: 0 } });
        expect(await crashed.lineage.destroyRevokedSecret(r.grant.id)).toMatchObject({ ok: false, reason: 'pending' });
        expect((await columns(r.grant.id)).lineage_claim_kind).toBe('destroy');
        await expireClaim(r.grant.id);

        const fresh = replica(r, r.h.openWith(r.h.realRepo));
        expect(await fresh.lineage.recoverLineage(r.grant.id)).toBe('destroyed');
        const after = await columns(r.grant.id);
        expect(after.secret_version).toBeNull();
        expect(after.secret_destroyed_at).not.toBeNull();
        expect(after.lineage_claim).toBeNull();
        expect(after.version).toBe(before.version);
        expect(after.authority).toEqual(before.authority);
        expect(await activeOf(r, r.h.open())).toMatchObject({ ok: false, error: { code: 'not-found' } });
    });

    it('crash before the delete call: the claim is cleared and the next pass destroys with a fresh operation', async () => {
        const r = await revokedRig();
        const spy = spied(r.h.open());
        const a = replica(r, spy.store);
        const claim = ok(await a.lineage.claimLineage(r.grant.id, 'destroy', { rotates: false })).claim;
        const op = await spy.store.issueOperationId();
        await db.sql`
            update integration_grant set lineage_operation_id = ${op}, lineage_secret_ref = secret_ref
            where id = ${r.grant.id} and lineage_claim = ${claim.token}
        `;
        await expireClaim(r.grant.id);
        const before = await columns(r.grant.id);
        expect(await a.lineage.recoverLineage(r.grant.id)).toBe('released');
        const cleared = await columns(r.grant.id);
        expect(cleared.lineage_claim).toBeNull();
        expect(cleared.lineage_operation_id).toBeNull();
        expect(cleared.secret_version).toBe(before.secret_version);

        expect(await a.lineage.destroyRevokedSecret(r.grant.id)).toMatchObject({ ok: true });
        expect(spy.log.operationIds).toHaveLength(2);
        expect(spy.log.operationIds[1]).not.toBe(op);
        const after = await columns(r.grant.id);
        expect(after.secret_version).toBeNull();
        expect(after.version).toBe(before.version);
        expect(after.authority).toEqual(before.authority);
    });
});

describe.skipIf(!enabled)('grant lineage: cancellation and exchange outcomes', () => {
    it('cancel before dispatch releases the claim, and the next resolve exchanges once', async () => {
        const r = await rig();
        const controller = new AbortController();
        const aborting: OAuthProviderHooks = {
            ...r.fake.hooks,
            refresh: (input) => {
                controller.abort();
                return r.fake.hooks.refresh(input);
            },
        };
        const a = replica(r, r.secrets, { hooks: aborting });
        expect(
            await a.resolver.resolveCredential(
                ctx(),
                { rootJobId: r.root, connectionId: r.connections[0]! },
                { signal: controller.signal }
            )
        ).toMatchObject({ ok: false, outcome: { outcome: 'unavailable', reason: 'aborted' } });
        await a.lineage.idle();
        expect(r.fake.refreshCalls).toBe(0);
        expect((await columns(r.grant.id)).lineage_claim).toBeNull();

        const b = replica(r, r.secrets);
        expect(tokenOf(await resolve(b.resolver, r))).toBe('access-1');
        expect(r.fake.refreshCalls).toBe(1);
    });

    it('cancel after provider acceptance, rotating: persistence still completes', async () => {
        const r = await rig({ rotates: true });
        const a = replica(r, r.secrets);
        const controller = new AbortController();
        const park = r.fake.parkNext();
        const pending = resolve(a.resolver, r, 0, controller.signal);
        await park.accepted;
        park.release('ok');
        controller.abort();
        expect(await pending).toMatchObject({ ok: false, outcome: { reason: 'aborted' } });
        await a.lineage.idle();
        expect((await columns(r.grant.id)).version).toBe(String(r.grant.version + 1));
        expect(tokenOf(await resolve(a.resolver, r))).toBe('access-1');
        expect(r.fake.refreshCalls).toBe(1);
    });

    it('abort after dispatch with no answer, rotating: reconnect_required, never re-exchanged', async () => {
        const r = await rig({ rotates: true });
        const a = replica(r, r.secrets);
        const controller = new AbortController();
        const park = r.fake.parkNext();
        const pending = resolve(a.resolver, r, 0, controller.signal);
        await park.accepted;
        controller.abort();
        await pending;
        await a.lineage.idle();
        expect(r.fake.refreshCalls).toBe(1);
        expect((await columns(r.grant.id)).status).toBe('reconnect_required');
        expect(await resolve(a.resolver, r)).toMatchObject({
            ok: false,
            outcome: { outcome: 'integration_required', reason: 'reconnect' },
        });
        expect(r.fake.refreshCalls).toBe(1);
    });

    it('abort after dispatch with no answer, non-rotating: the claim is released and the next resolve exchanges', async () => {
        const r = await rig({ rotates: false });
        const a = replica(r, r.secrets);
        const controller = new AbortController();
        const park = r.fake.parkNext();
        const pending = resolve(a.resolver, r, 0, controller.signal);
        await park.accepted;
        controller.abort();
        await pending;
        await a.lineage.idle();
        expect((await columns(r.grant.id)).status).toBe('active');
        expect((await columns(r.grant.id)).lineage_claim).toBeNull();
        expect(tokenOf(await resolve(a.resolver, r))).toBe('access-2');
    });

    it.each([
        ['rotating', true],
        ['non-rotating', false],
    ] as const)('expired claim without an operation ID (%s)', async (_label, rotates) => {
        const r = await rig({ rotates });
        const dead = replica(r, r.secrets);
        ok(await dead.lineage.claimLineage(r.grant.id, 'refresh', { rotates }));
        await expireClaim(r.grant.id);
        const live = replica(r, r.secrets);
        const result = await resolve(live.resolver, r);
        if (rotates) {
            expect(result).toMatchObject({ ok: false, outcome: { reason: 'reconnect' } });
            expect(r.fake.refreshCalls).toBe(0);
            expect((await columns(r.grant.id)).status).toBe('reconnect_required');
        } else {
            expect(tokenOf(result)).toBe('access-1');
            expect(r.fake.refreshCalls).toBe(1);
        }
    });

    it('invalid_grant from refresh → reconnect_required; not-sent → claim released and unavailable', async () => {
        const r = await rig({ rotates: true });
        const a = replica(r, r.secrets);
        r.fake.answerNext('invalid_grant');
        expect(await resolve(a.resolver, r)).toMatchObject({ ok: false, outcome: { reason: 'reconnect' } });
        expect((await columns(r.grant.id)).status).toBe('reconnect_required');

        const s = await rig();
        const notSent: OAuthProviderHooks = {
            ...s.fake.hooks,
            refresh: async () => ({ ok: false, failure: 'not-sent' }),
        };
        const b = replica(s, s.secrets, { hooks: notSent });
        expect((await resolve(b.resolver, s)).ok).toBe(false);
        const row = await columns(s.grant.id);
        expect(row.status).toBe('active');
        expect(row.lineage_claim).toBeNull();
    });
});

describe.skipIf(!enabled)('grant lineage: reconsent finalize', () => {
    const payload = (): GrantPayload => ({
        accessToken: 'access-c',
        accessExpiresAt: freshToken(),
        refreshToken: 'refresh-c',
        authority: { scopes: ['fake:read', 'fake:write'] },
    });

    it('restores active from reconnect_required', async () => {
        const r = await rig();
        await db.sql`update integration_grant set status = 'reconnect_required' where id = ${r.grant.id}`;
        const a = replica(r, r.secrets);
        const claim = ok(await a.lineage.claimLineage(r.grant.id, 'reconsent', { rotates: false })).claim;
        expect(await a.lineage.commitLineage(claim, payload())).toMatchObject({ ok: true });
        const row = await columns(r.grant.id);
        expect(row.status).toBe('active');
        expect(row.version).toBe(String(r.grant.version + 1));
        expect(row.authority).toEqual({ scopes: ['fake:read', 'fake:write'] });
        expect(await readGrant(db.sql, ORG, r.grant.id)).toMatchObject({ status: 'active' });
    });

    it('preserves a concurrent revoked', async () => {
        const hold = parked();
        const r = await rig({
            store: (h) =>
                faultyStore(h, {
                    activate: async (run, _call, [, origin]) => {
                        const result = await run();
                        if (origin === 'request') await hold.hold();
                        return result;
                    },
                }).store,
        });
        const a = replica(r, r.secrets);
        const claim = ok(await a.lineage.claimLineage(r.grant.id, 'reconsent', { rotates: false })).claim;
        const committing = a.lineage.commitLineage(claim, payload());
        await hold.entered;
        const store = createConnectionStore({ sql: db.sql, orgId: ORG });
        expect((await store.disconnect(r.connections[0]!, { userId: ALICE.id, admin: false })).disconnected).toBe(true);
        hold.release();
        expect(await committing).toMatchObject({ ok: true });
        const row = await columns(r.grant.id);
        expect(row.status).toBe('revoked');
        expect(row.secret_version).not.toBe(r.seededVersion);
    });
});

describe.skipIf(!enabled)('grant lineage: review r1 (A1) a mutation that outlives the lease that fences it', () => {
    // The lease is the sum of the budgets; compressed so the fence passes within milliseconds of real time.
    const COMPRESSED: Partial<LineageTiming> = {
        readDeadlineMs: 0,
        exchangeDeadlineMs: 0,
        persistBudgetMs: 300,
        marginMs: 100,
    };

    const newPayload = (): GrantPayload => ({
        accessToken: 'access-late',
        accessExpiresAt: freshToken(),
        refreshToken: 'refresh-late',
        authority: { scopes: ['fake:read'] },
    });

    it('a replace parked past its lease is not released by recovery while it may still land, and its late write never ends ahead of the recorded version', async () => {
        const hold = parked();
        const r = await rig({
            rotates: true,
            store: (h) =>
                faultyStore(h, {
                    stageVersion: async (run) => {
                        await hold.hold();
                        return run();
                    },
                }).store,
        });
        const holder = replica(r, r.secrets, { timing: COMPRESSED });
        const claim = ok(await holder.lineage.claimLineage(r.grant.id, 'refresh', { rotates: true })).claim;
        const committing = holder.lineage.commitLineage(claim, newPayload());
        await hold.entered;

        // The lease lapses with the mutation parked inside the store: nothing recorded it as run or not run.
        await expireClaim(r.grant.id);
        expect(await holder.lineage.recoverLineage(r.grant.id)).toBe('left');
        const stillHeld = await columns(r.grant.id);
        expect(stillHeld.lineage_claim).not.toBeNull();
        expect(stillHeld.lineage_operation_id).not.toBeNull();

        // The holder gives the wait up at its fence, but the mutation is still accounted for.
        expect(await committing).toMatchObject({ ok: false, reason: 'persistence-pending' });
        expect(await holder.lineage.recoverLineage(r.grant.id)).toBe('left');

        hold.release();
        await holder.lineage.idle();
        const fresh = replica(r, r.h.openWith(r.h.realRepo));
        expect(['finalized', 'wedged']).toContain(await fresh.lineage.recoverLineage(r.grant.id));
        const after = await columns(r.grant.id);
        const active = await activeOf(r, r.h.openWith(r.h.realRepo));
        if (!active.ok) throw new Error('the active secret is unreadable');
        // Either the grant records the version the store holds, or the reference is wedged: never behind a silent write.
        expect(after.secret_wedged_at !== null || after.secret_version === active.version).toBe(true);
        expect(r.fake.refreshCalls).toBe(0);
    });

    it('no mutation starts once the claim has no lease left: nothing reaches the store', async () => {
        const calls = { stage: 0 };
        const r = await rig({
            rotates: true,
            store: (h) =>
                faultyStore(h, {
                    stageVersion: async (run) => {
                        calls.stage += 1;
                        return run();
                    },
                }).store,
        });
        const holder = replica(r, r.secrets, { timing: { ...COMPRESSED, persistBudgetMs: 0, marginMs: 1_000_000 } });
        const claim = ok(await holder.lineage.claimLineage(r.grant.id, 'refresh', { rotates: true })).claim;
        expect(await holder.lineage.commitLineage(claim, newPayload())).toMatchObject({
            ok: false,
            reason: 'persistence-pending',
        });
        expect(calls.stage).toBe(0);
    });
});

describe.skipIf(!enabled)('grant lineage: review r2, a durable fence at the store before ownership is released', () => {
    const newPayload = (): GrantPayload => ({
        accessToken: 'access-r2',
        accessExpiresAt: freshToken(),
        refreshToken: 'refresh-r2',
        authority: { scopes: ['fake:read'] },
    });
    const consistent = async (r: Rig, ref: string | null = null) => {
        const row = await columns(r.grant.id);
        const active = await r.h
            .open()
            .readActive({ identity: grantSecretIdentity(r.grant), ref: (ref ?? row.secret_ref) as SecretRef });
        if (!active.ok) throw new Error('the active secret is unreadable');
        expect(active.version).toBe(row.secret_version);
    };
    const opOf = async (r: Rig) => (await columns(r.grant.id)).lineage_operation_id as never;
    const reconcileState = async (r: Rig, operationId: never) =>
        r.h.open().reconcileOperation({ identity: grantSecretIdentity(r.grant), ref: r.ref, operationId });

    it.each([
        ['refresh', true, 'reconnect-required'],
        ['refresh', false, 'released'],
        ['reconsent', true, 'reconnect-required'],
    ] as const)(
        '%s (rotating %s): paused before the store call, recovery fences the operation, the late replace is refused and the next commit works',
        async (kind, rotates, recovered) => {
            const gate = parked();
            const r = await rig({ rotates });
            const a = replica(r, parkBeforeStore(r.h.open(), 'replace', gate));
            const b = replica(r, r.h.open());
            const claim = ok(await a.lineage.claimLineage(r.grant.id, kind, { rotates })).claim;
            const committing = a.lineage.commitLineage(claim, newPayload());
            await gate.entered;
            const operationId = await opOf(r);
            await expireClaim(r.grant.id);

            expect(await b.lineage.recoverLineage(r.grant.id)).toBe(recovered);
            // The poison bound the recorded operation to a failure: nothing can apply under that ID any more.
            expect(await reconcileState(r, operationId)).toMatchObject({ ok: true, status: { state: 'failed' } });

            gate.release();
            expect(await committing).toMatchObject({ ok: false });
            await consistent(r);
            expect((await columns(r.grant.id)).version).toBe(String(r.grant.version));

            const again = ok(await b.lineage.claimLineage(r.grant.id, 'reconsent', { rotates })).claim;
            expect(await b.lineage.commitLineage(again, newPayload())).toMatchObject({ ok: true });
            const back = await columns(r.grant.id);
            expect(back.status).toBe('active');
            expect(back.version).toBe(String(r.grant.version + 1));
            await consistent(r);
        }
    );

    it('paused after the intent was inserted: the fence loses the race, the grant wedges, a late activation cannot corrupt it', async () => {
        const gate = parked();
        const r = await rig({ rotates: true });
        const late = faultyStore(r.h, {
            insertIntent: async (run) => {
                const row = await run();
                await gate.hold();
                return row;
            },
        }).store;
        const a = replica(r, late);
        const b = replica(r, r.h.open());
        const claim = ok(await a.lineage.claimLineage(r.grant.id, 'refresh', { rotates: true })).claim;
        const committing = a.lineage.commitLineage(claim, newPayload());
        await gate.entered;
        await expireClaim(r.grant.id);

        expect(await b.lineage.recoverLineage(r.grant.id)).toBe('wedged');
        gate.release();
        await committing;
        await a.lineage.idle();
        const wedged = await columns(r.grant.id);
        expect(wedged.status).toBe('reconnect_required');
        expect(wedged.secret_wedged_at).not.toBeNull();
        expect(wedged.version).toBe(String(r.grant.version));

        const fresh = ok(await b.lineage.claimLineage(r.grant.id, 'reconsent', { rotates: true })).claim;
        expect(await b.lineage.commitLineage(fresh, newPayload())).toMatchObject({ ok: true });
        const back = await columns(r.grant.id);
        expect(back.secret_ref).not.toBe(r.ref);
        await consistent(r, back.secret_ref);
    });

    it('the intent lands between the reconcile and the fence: the fence answers bound and the reconcile is repeated, the grant wedges', async () => {
        const gate = parked();
        const r = await rig({ rotates: true });
        const late = faultyStore(r.h, {
            insertIntent: async (run) => {
                const row = await run();
                await gate.hold();
                return row;
            },
        }).store;
        const a = replica(r, late);
        const claim = ok(await a.lineage.claimLineage(r.grant.id, 'refresh', { rotates: true })).claim;
        const committing = a.lineage.commitLineage(claim, newPayload());
        await gate.entered;
        await expireClaim(r.grant.id);
        // B's first lookup misses the intent (it was not visible yet when B looked); the fence then finds it bound.
        const b = replica(
            r,
            faultyStore(r.h, { findOperation: async (run, call) => (call === 1 ? (null as never) : run()) }).store
        );

        expect(await b.lineage.recoverLineage(r.grant.id)).toBe('wedged');
        gate.release();
        await committing;
        await a.lineage.idle();
        expect((await columns(r.grant.id)).status).toBe('reconnect_required');
    });

    it('destroy paused before the delete: the fence releases, the late delete is refused, the next pass destroys', async () => {
        const gate = parked();
        const r = await rig({ expired: false });
        await createConnectionStore({ sql: db.sql, orgId: ORG }).disconnect(r.connections[0]!, {
            userId: ALICE.id,
            admin: false,
        });
        const a = replica(r, parkBeforeStore(r.h.open(), 'delete', gate));
        const b = replica(r, r.h.open());
        const destroying = a.lineage.destroyRevokedSecret(r.grant.id);
        await gate.entered;
        await expireClaim(r.grant.id);

        expect(await b.lineage.recoverLineage(r.grant.id)).toBe('released');
        gate.release();
        expect(await destroying).toMatchObject({ ok: false });
        // The late delete did not land: the secret is still the version the grant records.
        await consistent(r);

        expect(await b.lineage.destroyRevokedSecret(r.grant.id)).toMatchObject({ ok: true });
        const after = await columns(r.grant.id);
        expect(after.secret_version).toBeNull();
        expect(await activeOf(r, r.h.open())).toMatchObject({ ok: false, error: { code: 'not-found' } });
    });

    it('a fence the store did not confirm leaves the claim and the operation; the next pass fences and releases', async () => {
        const r = await rig({ rotates: true });
        const spy = spied(r.h.open());
        const a = replica(r, spy.store);
        const claim = ok(await a.lineage.claimLineage(r.grant.id, 'refresh', { rotates: true })).claim;
        const op = await spy.store.issueOperationId();
        await db.sql`
            update integration_grant set lineage_operation_id = ${op}, lineage_secret_ref = secret_ref
            where id = ${r.grant.id} and lineage_claim = ${claim.token}
        `;
        await expireClaim(r.grant.id);
        // The store retries an idempotent write itself, so it fails for as long as the fault stands.
        const fault = { standing: true };
        const flaky = faultyStore(r.h, {
            insertFailure: async (run) => {
                if (fault.standing) throw ambiguousWrite();
                return run();
            },
        }).store;
        const b = replica(r, flaky);

        expect(await b.lineage.recoverLineage(r.grant.id)).toBe('left');
        const held = await columns(r.grant.id);
        expect(held.lineage_claim).toBe(claim.token);
        expect(held.lineage_operation_id).toBe(op);

        fault.standing = false;
        expect(await b.lineage.recoverLineage(r.grant.id)).toBe('reconnect-required');
        expect((await columns(r.grant.id)).lineage_claim).toBeNull();
    });

    it('the fence never deletes: on an active reference it is fenced and the bytes and version stay', async () => {
        const { fenceOperation } = await import('../src/integrations/operation-fence.js');
        const r = await rig();
        const store = r.h.open();
        const before = await activeOf(r, store);
        expect(
            await fenceOperation(store, {
                identity: grantSecretIdentity(r.grant),
                ref: r.ref,
                operationId: await store.issueOperationId(),
                signal: undefined,
            })
        ).toBe('fenced');
        const after = await activeOf(r, store);
        expect(after).toEqual(before);
    });

    it('a holder paused before recording its operation cannot record it after the lease expired, and never calls the store', async () => {
        const gate = parked();
        const r = await rig({ rotates: true });
        const spy = spied(r.h.open());
        const slow: SecretStore = {
            ...spy.store,
            issueOperationId: async () => {
                const id = await spy.store.issueOperationId();
                await gate.hold();
                return id;
            },
        };
        const a = replica(r, slow);
        const claim = ok(await a.lineage.claimLineage(r.grant.id, 'refresh', { rotates: true })).claim;
        const committing = a.lineage.commitLineage(claim, newPayload());
        await gate.entered;
        await expireClaim(r.grant.id);
        gate.release();

        expect(await committing).toMatchObject({ ok: false });
        expect(spy.log.replaces).toBe(0);
        expect((await columns(r.grant.id)).lineage_operation_id).toBeNull();
    });
});
