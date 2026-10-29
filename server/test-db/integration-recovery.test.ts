import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnectionGrants } from '../src/db/connection-grants.js';
import { createConnectionStore } from '../src/db/connection-store.js';
import type { LineageTiming } from '../src/integrations/grant-lineage.js';
import {
    createIntegrationRuntime,
    recoverIntegrations,
    startIntegrationRecovery,
} from '../src/integrations/integration-recovery.js';
import { contextOfSession } from '../src/integrations/trusted-context.js';
import type { SecretRef, SecretStore } from '../src/secrets/secret-store.js';
import { createFakeOAuth } from '../test/integrations-fake-provider.js';
import { testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';
import {
    attachJira,
    faultyStore,
    lineageHarness,
    seedGrantSecret,
    throwAfterActivate,
} from './integration-store-faults.js';
import type { PostgresHarness } from './secrets-postgres-harness.js';

/**
 * BEL-138 slice 4: the background pass that adopts what a lost board pod left. It is driven here exactly as main.ts
 * drives it (a runtime over the shared pool, one pass per tick); the loop's own timers are compressed with fake timers.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const ALICE = testUser('recovery-alice');
const db = useTestDb({ orgs: [ORG], users: [ALICE], max: 12 });

const CRASHED: Partial<LineageTiming> = { retryDelayMs: 0, persistBudgetMs: 0 };

function runtimeOver(
    secrets: SecretStore,
    fake = createFakeOAuth({ rotates: true }),
    timing: Partial<LineageTiming> = { retryDelayMs: 0 }
) {
    const runtime = createIntegrationRuntime({
        sql: db.sql,
        secrets,
        providers: (provider) => (provider === 'jira' ? fake.hooks : undefined),
        clients: (provider) => (provider === 'jira' ? { clientId: 'client-1', scopes: ['fake:read'] } : undefined),
        callbackOrigin: 'https://board.example.test',
        timing,
    });
    return { runtime, fake };
}

interface GrantRow {
    status: string;
    secret_version: string | null;
    secret_wedged_at: Date | null;
    lineage_claim: string | null;
    lineage_operation_id: string | null;
    lineage_claim_kind: string | null;
}
const grantRow = async (id: string): Promise<GrantRow> =>
    (
        await db.sql<GrantRow[]>`
            select status, secret_version, secret_wedged_at, lineage_claim, lineage_operation_id, lineage_claim_kind
            from integration_grant where id = ${id}
        `
    )[0]!;
const expireClaim = (id: string) =>
    db.sql`update integration_grant set lineage_claim_expires_at = now() - interval '1 second' where id = ${id}`;

/** An established grant with a stored (expired) access token, written the way an earlier completion would have. */
async function seedGrant(h: PostgresHarness, fake = createFakeOAuth({ rotates: true })) {
    const grants = createConnectionGrants({ sql: db.sql, orgId: ORG });
    const attached = await attachJira(grants, ALICE.id, {
        externalAccountId: `acct-${randomUUID()}`,
        cloudId: `cloud-${randomUUID()}`,
    });
    const seed = await seedGrantSecret(db.sql, h.open(), attached.grant, {
        accessToken: 'access-seed',
        accessExpiresAt: Date.now() - 60_000,
        refreshToken: fake.currentRefreshToken,
        authority: { scopes: ['fake:read'] },
    });
    return { grant: attached.grant, connectionId: attached.connectionId, ref: seed.ref as SecretRef };
}

const revoke = async (connectionId: string) => {
    const done = await createConnectionStore({ sql: db.sql, orgId: ORG }).disconnect(connectionId, {
        userId: ALICE.id,
        admin: false,
    });
    if (!done.revokedGrantId) throw new Error('the disconnect revoked no grant');
    return done.revokedGrantId;
};

const payload = () => ({
    accessToken: 'access-new',
    accessExpiresAt: Date.now() + 3_600_000,
    refreshToken: 'refresh-new',
    authority: { scopes: ['fake:read'] },
});

/** Leaves `kind`'s persistence recorded and unfinished (a lost response, the holder gone) with its lease lapsed. */
async function crashMidPersistence(h: PostgresHarness, kind: 'refresh' | 'reconsent' | 'destroy') {
    const crashing = faultyStore(h, { activate: throwAfterActivate }).store;
    const { runtime } = runtimeOver(crashing, undefined, CRASHED);
    const seeded = await seedGrant(h);
    const lineage = runtime.lineageOf(ORG);
    if (kind === 'destroy') {
        await revoke(seeded.connectionId);
        expect(await lineage.destroyRevokedSecret(seeded.grant.id)).toMatchObject({ ok: false, reason: 'pending' });
    } else {
        const claimed = await lineage.claimLineage(seeded.grant.id, kind, { rotates: true });
        if (!claimed.ok) throw new Error(`claim refused: ${claimed.reason}`);
        expect(await lineage.commitLineage(claimed.claim, payload())).toMatchObject({
            ok: false,
            reason: 'persistence-pending',
        });
    }
    const pending = await grantRow(seeded.grant.id);
    expect(pending.lineage_claim_kind).toBe(kind);
    expect(pending.lineage_operation_id).not.toBeNull();
    await expireClaim(seeded.grant.id);
    return seeded;
}

const secretsOf = (h: PostgresHarness) => h.open();

describe.skipIf(!enabled)('integration recovery pass', () => {
    it.each(['refresh', 'reconsent', 'destroy'] as const)(
        'adopts an expired %s claim whose operation was recorded',
        async (kind) => {
            const h = lineageHarness(db.sql);
            const seeded = await crashMidPersistence(h, kind);
            const { runtime } = runtimeOver(h.openWith(h.realRepo));

            const summary = await recoverIntegrations(runtime);

            expect(summary.grants).toBeGreaterThanOrEqual(1);
            const after = await grantRow(seeded.grant.id);
            expect(after.lineage_claim).toBeNull();
            expect(after.lineage_operation_id).toBeNull();
            if (kind === 'destroy') expect(after.secret_version).toBeNull();
            else expect(after.secret_version).not.toBeNull();
        }
    );

    it("destroys a revoked grant's secret and skips a wedged one", async () => {
        const h = lineageHarness(db.sql);
        const live = await seedGrant(h);
        const wedged = await seedGrant(h);
        await revoke(live.connectionId);
        await revoke(wedged.connectionId);
        await db.sql`update integration_grant set secret_wedged_at = now() where id = ${wedged.grant.id}`;
        const { runtime } = runtimeOver(secretsOf(h));

        const summary = await recoverIntegrations(runtime);

        expect(summary.destroyed).toBeGreaterThanOrEqual(1);
        expect((await grantRow(live.grant.id)).secret_version).toBeNull();
        const stuck = await grantRow(wedged.grant.id);
        expect(stuck.secret_version).not.toBeNull();
        expect(stuck.lineage_claim).toBeNull();
    });

    it('expires a stale authorization and leaves a live one', async () => {
        const h = lineageHarness(db.sql);
        const { runtime } = runtimeOver(secretsOf(h));
        const flow = runtime.flowOf(ORG);
        const ctx = contextOfSession({ user: { id: ALICE.id } }, ORG);
        const start = async () => {
            const started = await flow.startAuthorization(ctx, { provider: 'jira' });
            if (!started.ok) throw new Error(`start refused: ${started.reason}`);
            return started.authorizationId;
        };
        const stale = await start();
        const live = await start();
        await db.sql`update integration_authorization set expires_at = now() - interval '1 second' where id = ${stale}`;
        const statusOf = async (id: string) =>
            (await db.sql<{ status: string }[]>`select status from integration_authorization where id = ${id}`)[0]!
                .status;

        const summary = await recoverIntegrations(runtime);

        expect(summary.authorizations).toBeGreaterThanOrEqual(1);
        expect(await statusOf(stale)).toBe('expired');
        expect(await statusOf(live)).toBe('pending');
    });

    it('a pass whose store throws leaves every row, and the next pass adopts them', async () => {
        const h = lineageHarness(db.sql);
        const crashedGrant = await crashMidPersistence(h, 'refresh');
        const revokedGrant = await seedGrant(h);
        await revoke(revokedGrant.connectionId);
        const before = [await grantRow(crashedGrant.grant.id), await grantRow(revokedGrant.grant.id)];
        const broken = new Proxy({} as SecretStore, {
            get: () => () => {
                throw new Error('store down');
            },
        });
        const down = runtimeOver(broken).runtime;

        const summary = await recoverIntegrations(down);

        expect(summary.failed).toBeGreaterThanOrEqual(2);
        expect([await grantRow(crashedGrant.grant.id), await grantRow(revokedGrant.grant.id)]).toEqual(before);

        await recoverIntegrations(runtimeOver(h.openWith(h.realRepo)).runtime);
        expect((await grantRow(crashedGrant.grant.id)).lineage_claim).toBeNull();
        expect((await grantRow(revokedGrant.grant.id)).secret_version).toBeNull();
    });

    it('two passes back to back are idempotent', async () => {
        const h = lineageHarness(db.sql);
        const crashed = await crashMidPersistence(h, 'refresh');
        const revoked = await seedGrant(h);
        await revoke(revoked.connectionId);
        const { runtime } = runtimeOver(h.openWith(h.realRepo));

        await recoverIntegrations(runtime);
        const first = [await grantRow(crashed.grant.id), await grantRow(revoked.grant.id)];
        const again = await recoverIntegrations(runtime);

        expect([await grantRow(crashed.grant.id), await grantRow(revoked.grant.id)]).toEqual(first);
        expect(again).toMatchObject({ grants: 0, destroyed: 0, failed: 0 });
    });

    it('is bounded: one pass touches at most `limit` grants per kind of work, the next continues', async () => {
        const h = lineageHarness(db.sql);
        const { runtime } = runtimeOver(secretsOf(h));
        // Drain what earlier cases left, so the counts below are this case's own.
        for (let i = 0; i < 20 && (await recoverIntegrations(runtime)).destroyed > 0; i += 1);
        const revoked: string[] = [];
        for (let i = 0; i < 3; i += 1) {
            const seeded = await seedGrant(h);
            await revoke(seeded.connectionId);
            revoked.push(seeded.grant.id);
        }

        const first = await recoverIntegrations(runtime, { limit: 2 });
        const second = await recoverIntegrations(runtime, { limit: 2 });

        expect(first.destroyed).toBe(2);
        expect(second.destroyed).toBe(1);
        for (const id of revoked) expect((await grantRow(id)).secret_version).toBeNull();
    });

    it('stops between items when its signal aborts, leaving the rest for the next pass', async () => {
        const h = lineageHarness(db.sql);
        const { runtime } = runtimeOver(secretsOf(h));
        for (let i = 0; i < 20 && (await recoverIntegrations(runtime)).destroyed > 0; i += 1);
        const seeded = await seedGrant(h);
        await revoke(seeded.connectionId);

        const stopped = await recoverIntegrations(runtime, { signal: AbortSignal.abort() });

        expect(stopped.destroyed).toBe(0);
        expect((await grantRow(seeded.grant.id)).secret_version).not.toBeNull();
        expect((await recoverIntegrations(runtime)).destroyed).toBe(1);
    });

    it('destroyRevokedSecret on the runtime acts for the named org and only on a revoked grant', async () => {
        const h = lineageHarness(db.sql);
        const { runtime } = runtimeOver(secretsOf(h));
        const seeded = await seedGrant(h);

        expect(await runtime.destroyRevokedSecret(ORG, seeded.grant.id)).toMatchObject({
            ok: false,
            reason: 'not-revoked',
        });
        expect((await grantRow(seeded.grant.id)).secret_version).not.toBeNull();

        const revokedId = await revoke(seeded.connectionId);
        expect(await runtime.destroyRevokedSecret(ORG, revokedId)).toEqual({ ok: true });
        expect((await grantRow(seeded.grant.id)).secret_version).toBeNull();
    });
});

describe('integration recovery loop', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('runs a pass at start and on each tick, never overlapping one with the previous', async () => {
        vi.useFakeTimers();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const pass = vi.fn(async () => {
            if (pass.mock.calls.length === 1) await gate;
        });
        const stop = startIntegrationRecovery(pass, 1000);
        expect(pass).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(3000);
        expect(pass).toHaveBeenCalledTimes(1);

        release();
        await vi.advanceTimersByTimeAsync(1000);
        expect(pass).toHaveBeenCalledTimes(2);
        stop();
    });

    it('survives a pass that throws, logging a closed message and never the error text', async () => {
        vi.useFakeTimers();
        const lines: string[] = [];
        const pass = vi.fn(async () => {
            throw new Error('token=SECRET-VALUE');
        });
        const stop = startIntegrationRecovery(pass, 1000, (line) => lines.push(line));
        await vi.advanceTimersByTimeAsync(2000);

        expect(pass).toHaveBeenCalledTimes(3);
        expect(lines.length).toBe(3);
        expect(lines.join('\n')).not.toContain('SECRET-VALUE');
        stop();
    });

    it('stops cleanly: no further tick, and the running pass is told to stop', async () => {
        vi.useFakeTimers();
        const signals: AbortSignal[] = [];
        const pass = vi.fn(async (signal: AbortSignal) => {
            signals.push(signal);
        });
        const stop = startIntegrationRecovery(pass, 1000);
        await vi.advanceTimersByTimeAsync(1000);
        expect(pass).toHaveBeenCalledTimes(2);

        stop();
        await vi.advanceTimersByTimeAsync(5000);

        expect(pass).toHaveBeenCalledTimes(2);
        expect(signals.every((signal) => signal.aborted)).toBe(true);
    });
});
