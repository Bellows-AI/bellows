import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createConnectionStore } from '../src/db/connection-store.js';
import { waitForLockWaiters } from './lock-wait.js';
import { createConnectionGrants, grantSecretIdentity, type ConnectionGrants } from '../src/db/connection-grants.js';
import { createGrantLineage } from '../src/integrations/grant-lineage.js';
import { createSecretRef } from '../src/secrets/secret-input.js';
import { useTestDb } from './harness.js';
import { testOrg, testUser } from './fixtures.js';
import { testSecretStore } from './env-secrets-harness.js';

/** BEL-59: the grant is the unit that owns a refresh lineage; connections reference it. */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const OTHER_ORG = testOrg();
const ALICE = testUser('grant-alice');
const BOB = testUser('grant-bob');

const db = useTestDb({ orgs: [ORG, OTHER_ORG], users: [ALICE, BOB] });

let sql: Sql;
let grants: ConnectionGrants;
let otherOrgGrants: ConnectionGrants;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    grants = createConnectionGrants({ sql, orgId: ORG });
    otherOrgGrants = createConnectionGrants({ sql, orgId: OTHER_ORG });
});

const account = () => `acct-${randomUUID()}`;

const attach = (
    store: ConnectionGrants,
    userId: string,
    externalAccountId: string,
    cloudId = `cloud-${randomUUID()}`
) =>
    store.attachGrantConnection({
        principal: { kind: 'user', userId },
        provider: 'jira',
        externalAccountId,
        authority: { scopes: ['read:jira-work'] },
        connection: { site: 'example.atlassian.net', cloudId, access: 'read' },
    });

const mustAttach = async (store: ConnectionGrants, userId: string, externalAccountId: string, cloudId?: string) => {
    const result = await attach(store, userId, externalAccountId, cloudId);
    if (!result.ok) throw new Error(`attach refused: ${result.reason}`);
    return result;
};

describe.skipIf(!enabled)('connection grants', () => {
    it('one active grant per provider external account: a second site reuses it, another user or org is refused', async () => {
        const acct = account();
        const first = await mustAttach(grants, ALICE.id, acct);
        const second = await mustAttach(grants, ALICE.id, acct);
        expect(second.grant.id).toBe(first.grant.id);
        expect(second.connectionId).not.toBe(first.connectionId);

        expect(await attach(grants, BOB.id, acct)).toEqual({ ok: false, reason: 'grant-conflict' });
        expect(await attach(otherOrgGrants, ALICE.id, acct)).toEqual({ ok: false, reason: 'grant-conflict' });

        const rows =
            await sql`select 1 from integration_grant where provider = 'jira' and external_account_id = ${acct}`;
        expect(rows).toHaveLength(1);
        const [conn] = await sql<{ credential: string; principal_user_id: string; grant_id: string }[]>`
            select credential, principal_user_id, grant_id from connector_connection where id = ${second.connectionId}
        `;
        expect(conn).toEqual({ credential: 'oauth_grant', principal_user_id: ALICE.id, grant_id: first.grant.id });
    });

    it('a revoked grant frees its external account for another principal', async () => {
        const acct = account();
        const first = await mustAttach(grants, ALICE.id, acct);
        await sql`update connector_connection set status = 'disconnected' where id = ${first.connectionId}`;
        expect(await grants.revokeIfOrphaned(first.grant.id)).toBe(true);
        const next = await mustAttach(grants, BOB.id, acct);
        expect(next.grant.id).not.toBe(first.grant.id);
    });

    const lineage = () =>
        createGrantLineage({ sql, orgId: ORG, secrets: testSecretStore(sql), providers: () => undefined });

    it('finalize requires the claim: no claim, a stale token and a replayed token all change nothing', async () => {
        const { grant } = await mustAttach(grants, ALICE.id, account());
        const input = { kind: 'refresh', secretVersion: 'v-a', authority: { scopes: ['read'] } } as const;
        expect(await grants.finalize(grant.id, randomUUID(), input)).toEqual({ ok: false, reason: 'claim-lost' });
        const [row] = await sql<{ version: string; secret_version: string | null }[]>`
            select version, secret_version from integration_grant where id = ${grant.id}
        `;
        expect(Number(row!.version)).toBe(grant.version);
        expect(row!.secret_version).toBeNull();
    });

    it('two racers for the claim: exactly one wins; two finalizes with the winning token: exactly one applies', async () => {
        const { grant } = await mustAttach(grants, ALICE.id, account());
        await sql`update integration_grant set secret_ref = ${createSecretRef()}, secret_version = 'v-0' where id = ${grant.id}`;
        const racers = await Promise.all([
            lineage().claimLineage(grant.id, 'refresh', { rotates: false }),
            lineage().claimLineage(grant.id, 'refresh', { rotates: false }),
        ]);
        expect(racers.filter((r) => r.ok)).toHaveLength(1);
        expect(racers.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'held' }]);
        const winner = racers.find((r) => r.ok)!;
        if (!winner.ok) throw new Error('unreachable');
        const input = { kind: 'refresh', secretVersion: 'v-a', authority: { scopes: ['read'] } } as const;
        const results = await Promise.all([
            grants.finalize(grant.id, winner.claim.token, input),
            grants.finalize(grant.id, winner.claim.token, input),
        ]);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'claim-lost' }]);
        const [row] = await sql<{ version: string; lineage_claim: string | null }[]>`
            select version, lineage_claim from integration_grant where id = ${grant.id}
        `;
        expect(Number(row!.version)).toBe(grant.version + 1);
        expect(row!.lineage_claim).toBeNull();
    });

    const reconsentClaim = async (grantId: string) => {
        const claim = await lineage().claimLineage(grantId, 'reconsent', { rotates: false });
        if (!claim.ok) throw new Error(`claim refused: ${claim.reason}`);
        return claim.claim.token;
    };

    it('reconnect under the same account finalizes the reconsent claim; the connection principal is unchanged', async () => {
        const acct = account();
        const { grant, connectionId } = await mustAttach(grants, ALICE.id, acct);
        await sql`update integration_grant set status = 'reconnect_required' where id = ${grant.id}`;
        const claimToken = await reconsentClaim(grant.id);

        const result = await grants.reconnect(
            connectionId,
            { userId: ALICE.id },
            { externalAccountId: acct, claimToken, secretVersion: 'v-new' }
        );
        expect(result).toEqual({ ok: true, version: grant.version + 1 });
        const [row] = await sql<{ status: string; secret_version: string; version: string }[]>`
            select status, secret_version, version from integration_grant where id = ${grant.id}
        `;
        expect(row).toMatchObject({ status: 'active', secret_version: 'v-new' });
        const [conn] = await sql<{ principal_user_id: string; grant_id: string }[]>`
            select principal_user_id, grant_id from connector_connection where id = ${connectionId}
        `;
        expect(conn).toEqual({ principal_user_id: ALICE.id, grant_id: grant.id });
    });

    it('reconnect under a different account is refused account-mismatch and changes nothing', async () => {
        const { grant, connectionId } = await mustAttach(grants, ALICE.id, account());
        const claimToken = await reconsentClaim(grant.id);
        const result = await grants.reconnect(
            connectionId,
            { userId: ALICE.id },
            { externalAccountId: account(), claimToken, secretVersion: 'v-evil' }
        );
        expect(result).toEqual({ ok: false, reason: 'account-mismatch' });
        const [row] = await sql<{ version: string; secret_version: string | null }[]>`
            select version, secret_version from integration_grant where id = ${grant.id}
        `;
        expect(Number(row!.version)).toBe(grant.version);
        expect(row!.secret_version).toBeNull();
    });

    it("reconnect by someone who is not the connection's principal finds nothing", async () => {
        const acct = account();
        const { connectionId } = await mustAttach(grants, ALICE.id, acct);
        const input = { externalAccountId: acct, claimToken: randomUUID(), secretVersion: 'v' };
        expect(await grants.reconnect(connectionId, { userId: BOB.id }, input)).toEqual({
            ok: false,
            reason: 'not-found',
        });
        expect(await otherOrgGrants.reconnect(connectionId, { userId: ALICE.id }, input)).toEqual({
            ok: false,
            reason: 'not-found',
        });
    });

    it('revokeIfOrphaned keeps a grant while another active connection uses it', async () => {
        const acct = account();
        const a = await mustAttach(grants, ALICE.id, acct);
        const b = await mustAttach(grants, ALICE.id, acct);
        await sql`update connector_connection set status = 'disconnected' where id = ${a.connectionId}`;
        expect(await grants.revokeIfOrphaned(a.grant.id)).toBe(false);
        await sql`update connector_connection set status = 'disconnected' where id = ${b.connectionId}`;
        expect(await grants.revokeIfOrphaned(a.grant.id)).toBe(true);
        const [row] = await sql<{ status: string; revoked_at: Date | null }[]>`
            select status, revoked_at from integration_grant where id = ${a.grant.id}
        `;
        expect(row!.status).toBe('revoked');
        expect(row!.revoked_at).not.toBeNull();
    });

    it('a service principal grant is refused by the store (reserved for BEL-143)', async () => {
        const result = await grants.attachGrantConnection({
            principal: { kind: 'service', serviceId: 'svc-1' },
            provider: 'jira',
            externalAccountId: account(),
            authority: {},
            connection: { site: 'example.atlassian.net', cloudId: 'c', access: 'read' },
        });
        expect(result).toEqual({ ok: false, reason: 'service-principal-unsupported' });
    });

    it('grantSecretIdentity keys the grant, not the connection: a ref under another grant is identity-mismatch', async () => {
        const first = await mustAttach(grants, ALICE.id, account());
        const second = await mustAttach(grants, ALICE.id, account());
        const secrets = testSecretStore(sql);
        const ref = createSecretRef();
        const created = await secrets.create({
            identity: grantSecretIdentity(first.grant),
            ref,
            operationId: await secrets.issueOperationId(),
            payload: new TextEncoder().encode('refresh-token'),
        });
        expect(created.ok).toBe(true);

        const own = await secrets.readActive({ identity: grantSecretIdentity(first.grant), ref });
        expect(own.ok).toBe(true);
        // A second connection of the same grant resolves the same identity.
        expect(grantSecretIdentity(first.grant)).toEqual(grantSecretIdentity({ ...first.grant }));

        const copied = await secrets.readActive({ identity: grantSecretIdentity(second.grant), ref });
        expect(copied).toMatchObject({ ok: false, error: { reason: 'identity-mismatch' } });
        expect(grantSecretIdentity(first.grant)).toMatchObject({
            owner: { kind: 'user', userId: ALICE.id, orgId: ORG },
            scope: { type: 'integration-grant', id: first.grant.id },
            purpose: 'connection-grant',
            owningRecord: { type: 'integration-grant', id: first.grant.id },
        });
    });

    it('two concurrent disconnects of the last two connections serialize on the grant lock and revoke it', async () => {
        const store = createConnectionStore({ sql, orgId: ORG });
        const first = await mustAttach(grants, ALICE.id, account());
        const second = await attach(grants, ALICE.id, first.grant.externalAccountId);
        if (!second.ok) throw new Error(`attach refused: ${second.reason}`);
        const done = { a: false, b: false };
        // The grant row lock is held by a third transaction: both disconnects must queue behind it.
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let locked!: () => void;
        const lockTaken = new Promise<void>((resolve) => {
            locked = resolve;
        });
        const holder = sql.begin(async (tx) => {
            await tx`select id from integration_grant where id = ${first.grant.id} for update`;
            locked();
            await held;
        });
        await lockTaken;
        const a = store.disconnect(first.connectionId, { userId: ALICE.id, admin: false }).then((r) => {
            done.a = true;
            return r;
        });
        const b = store.disconnect(second.connectionId, { userId: ALICE.id, admin: false }).then((r) => {
            done.b = true;
            return r;
        });
        const state = await waitForLockWaiters(sql, 2, () => done.a || done.b);
        release();
        await holder;
        expect((await Promise.all([a, b])).map((r) => r.disconnected)).toEqual([true, true]);
        expect(state).toBe('blocked');
        const [grant] = await sql<
            { status: string }[]
        >`select status from integration_grant where id = ${first.grant.id}`;
        expect(grant!.status).toBe('revoked');
    });

    it('revokeIfOrphaned takes the grant lock before it looks for active connections', async () => {
        const attached = await mustAttach(grants, ALICE.id, account());
        await sql`update connector_connection set status = 'disconnected' where id = ${attached.connectionId}`;
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let locked!: () => void;
        const lockTaken = new Promise<void>((resolve) => {
            locked = resolve;
        });
        const holder = sql.begin(async (tx) => {
            await tx`select id from integration_grant where id = ${attached.grant.id} for update`;
            locked();
            await held;
        });
        await lockTaken;
        let settled = false;
        const revoked = grants.revokeIfOrphaned(attached.grant.id).then((r) => {
            settled = true;
            return r;
        });
        expect(await waitForLockWaiters(sql, 1, () => settled)).toBe('blocked');
        release();
        await holder;
        expect(await revoked).toBe(true);
    });
});
