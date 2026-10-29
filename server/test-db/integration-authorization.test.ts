import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnectionGrants, grantSecretIdentity } from '../src/db/connection-grants.js';
import { createConnectionStore } from '../src/db/connection-store.js';
import {
    type AuthorizationEvent,
    type CompleteAuthorizationInput,
    createAuthorizationFlow,
    type StartAuthorizationInput,
} from '../src/integrations/authorization-flow.js';
import { decodeGrantPayload } from '../src/integrations/grant-credentials.js';
import { createGrantLineage, type LineageEvent, type LineageTiming } from '../src/integrations/grant-lineage.js';
import type { OAuthProviderHooks } from '../src/integrations/oauth-provider.js';
import { contextOfSession } from '../src/integrations/trusted-context.js';
import type { SecretRef, SecretStore } from '../src/secrets/secret-store.js';
import { createFakeOAuth, type FakeOAuth } from '../test/integrations-fake-provider.js';
import { testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';
import {
    attachJira,
    faultyStore,
    lineageHarness,
    parkBeforeStore,
    parked,
    seedGrantSecret,
    spied,
    throwAfterActivate,
    throwBefore,
} from './integration-store-faults.js';
import { waitForLockWaiters } from './lock-wait.js';
import type { PostgresHarness } from './secrets-postgres-harness.js';

/**
 * BEL-138 slice 3: the authorization transaction as module functions. There is no HTTP route in this change, so the
 * callback validation (user binding, return path, replay, expiry) is exercised by calling the functions directly,
 * the way BEL-61's thin handlers will.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const ALICE = testUser('auth-alice');
const BOB = testUser('auth-bob');
const db = useTestDb({ orgs: [ORG], users: [ALICE, BOB], max: 14 });

const CODE = 'authcode-SECRET-1';
const asAlice = () => contextOfSession({ user: { id: ALICE.id } }, ORG);
const asBob = () => contextOfSession({ user: { id: BOB.id } }, ORG);
const sha256 = (value: string, encoding: 'hex' | 'base64url') => createHash('sha256').update(value).digest(encoding);
const stateOf = (authorizeUrl: string): string => new URL(authorizeUrl).searchParams.get('state')!;
const acctId = () => `acct-${randomUUID()}`;

interface RigOptions {
    rotates?: boolean;
    revokeScope?: 'token' | 'grant' | 'none';
    store?: (h: PostgresHarness) => SecretStore;
    timing?: Partial<LineageTiming>;
    hooks?: (fake: FakeOAuth) => OAuthProviderHooks;
    callbackOrigin?: string | null;
}

function rig(options: RigOptions = {}) {
    const fake = createFakeOAuth({ rotates: options.rotates ?? false, revokeScope: options.revokeScope ?? 'none' });
    const h = lineageHarness(db.sql);
    const secrets = options.store ? options.store(h) : h.open();
    const hooks = options.hooks ? options.hooks(fake) : fake.hooks;
    const lineageEvents: LineageEvent[] = [];
    const flowEvents: AuthorizationEvent[] = [];
    const lineage = createGrantLineage({
        sql: db.sql,
        orgId: ORG,
        secrets,
        providers: (provider) => (provider === 'jira' ? hooks : undefined),
        timing: { retryDelayMs: 0, ...options.timing },
        log: (event) => lineageEvents.push(event),
    });
    const flowOver = (over: { secrets?: SecretStore | undefined; callbackOrigin?: string | null | undefined } = {}) =>
        createAuthorizationFlow({
            sql: db.sql,
            orgId: ORG,
            secrets: over.secrets ?? secrets,
            lineage,
            providers: (provider) => (provider === 'jira' || provider === 'noclient' ? hooks : undefined),
            clients: (provider) =>
                provider === 'jira' ? { clientId: 'client-1', scopesFor: () => ['fake:read'] } : undefined,
            callbackOrigin: over.callbackOrigin === undefined ? 'https://board.example.test' : over.callbackOrigin,
            log: (event) => flowEvents.push(event),
        });
    const flow = flowOver({ callbackOrigin: options.callbackOrigin });
    return { fake, h, secrets, lineage, flow, flowOver, lineageEvents, flowEvents };
}
type Rig = ReturnType<typeof rig>;

async function begin(r: Rig, input: StartAuthorizationInput = { provider: 'jira' }, ctx = asAlice()) {
    const started = await r.flow.startAuthorization(ctx, input);
    if (!started.ok) throw new Error(`start refused: ${started.reason}`);
    return { ...started, state: stateOf(started.authorizeUrl) };
}

interface AuthRow {
    id: string;
    user_id: string;
    org_id: string;
    provider: string;
    intent: string;
    interaction_id: string | null;
    connection_id: string | null;
    grant_id: string | null;
    grant_claim: string | null;
    expected_account_id: string | null;
    state_hash: string;
    pkce_verifier: string | null;
    return_to: string;
    status: string;
    failure: string | null;
    pending_grant_id: string | null;
    secret_ref: string | null;
    secret_operation_id: string | null;
    result: Record<string, unknown> | null;
    consumed_at: Date | null;
    completed_at: Date | null;
}
const rowOf = async (id: string): Promise<AuthRow> =>
    (await db.sql<AuthRow[]>`select * from integration_authorization where id = ${id}`)[0]!;

interface GrantColumns {
    id: string;
    status: string;
    version: string;
    secret_ref: string | null;
    secret_version: string | null;
    lineage_claim: string | null;
    lineage_operation_id: string | null;
    principal_user_id: string;
}
const grantOf = async (id: string): Promise<GrantColumns> =>
    (
        await db.sql<GrantColumns[]>`
            select id, status, version, secret_ref, secret_version, lineage_claim, lineage_operation_id, principal_user_id
            from integration_grant where id = ${id}
        `
    )[0]!;
const grantsOfAccount = (account: string) =>
    db.sql<GrantColumns[]>`
        select id, status, version, secret_ref, secret_version, lineage_claim, lineage_operation_id, principal_user_id
        from integration_grant where external_account_id = ${account}
    `;
const connectionsOfAccount = (account: string) =>
    db.sql<{ id: string; status: string; grant_id: string; cloud_id: string; site: string; credential: string }[]>`
        select id, status, grant_id, cloud_id, site, credential from connector_connection
        where external_account_id = ${account} order by created_at
    `;

/** The authorization row is consumed long ago and its time is up: a holder that is still running would be dead. */
const lapse = (id: string) =>
    db.sql`
        update integration_authorization
        set consumed_at = now() - interval '1 hour', expires_at = now() - interval '1 hour',
            deadline_at = now() - interval '1 hour' where id = ${id}
    `;

interface Seeded {
    account: string;
    grantId: string;
    connectionId: string;
    ref: SecretRef;
}

/** An established connection with a stored secret, written the way an earlier completion would have. */
async function seedConnected(r: Rig, over: { status?: 'reconnect_required'; userId?: string } = {}): Promise<Seeded> {
    const account = acctId();
    const grants = createConnectionGrants({ sql: db.sql, orgId: ORG });
    const attached = await attachJira(grants, over.userId ?? ALICE.id, {
        externalAccountId: account,
        cloudId: `cloud-${randomUUID()}`,
    });
    const seed = await seedGrantSecret(db.sql, r.h.open(), attached.grant, {
        accessToken: 'access-seed',
        accessExpiresAt: Date.now() - 60_000,
        refreshToken: r.fake.currentRefreshToken,
        authority: { scopes: ['fake:read'] },
    });
    if (over.status) await db.sql`update integration_grant set status = ${over.status} where id = ${attached.grant.id}`;
    r.fake.identity = { ...r.fake.identity!, externalAccountId: account };
    return { account, grantId: attached.grant.id, connectionId: attached.connectionId, ref: seed.ref as SecretRef };
}

const storedPayload = async (r: Rig, grantId: string) => {
    const grant = await grantOf(grantId);
    const read = await r.h.open().readActive({
        identity: grantSecretIdentity({ id: grantId, orgId: ORG, principalUserId: grant.principal_user_id }),
        ref: grant.secret_ref as SecretRef,
    });
    if (!read.ok) throw new Error(`read refused: ${read.error.code}`);
    return decodeGrantPayload(read.value);
};

const complete = (r: Rig, input: CompleteAuthorizationInput, ctx = asAlice(), signal?: AbortSignal) =>
    r.flow.completeAuthorization(ctx, input, signal ? { signal } : {});

describe.skipIf(!enabled)('start: the trusted context binds the transaction', () => {
    it('binds user, org, provider, intent and interaction from the context only; stores the state hash, never the state', async () => {
        const r = rig();
        const interactionId = randomUUID();
        const input: StartAuthorizationInput = { provider: 'jira', interactionId };
        const started = await r.flow.startAuthorization(asAlice(), input);
        expect(started).toMatchObject({
            ok: true,
            authorizeUrl: expect.stringContaining('https://fake.test/authorize'),
        });
        if (!started.ok) return;
        const state = stateOf(started.authorizeUrl);
        const row = await rowOf(started.authorizationId);
        expect(row).toMatchObject({
            user_id: ALICE.id,
            org_id: ORG,
            provider: 'jira',
            intent: 'connect',
            interaction_id: interactionId,
            status: 'pending',
            state_hash: sha256(state, 'hex'),
        });
        expect(JSON.stringify(row)).not.toContain(state);
        expect(new Date(started.expiresAt).getTime()).toBeGreaterThan(Date.now());
        const call = r.fake.authorizeCalls[0]!;
        expect(call).toMatchObject({ state, redirectUri: expect.stringContaining('https://board.example.test/') });
        expect(call.codeChallenge).toBe(sha256(row.pkce_verifier!, 'base64url'));
    });

    it('the input type has no principal field, and a runtime extra key is ignored, never stored', async () => {
        const r = rig();
        // @ts-expect-error a principal is never an input: it comes from the trusted context
        const typed: StartAuthorizationInput = { provider: 'jira', userId: BOB.id };
        expect(typed.provider).toBe('jira');
        const started = await begin(r, {
            provider: 'jira',
            userId: BOB.id,
            orgId: testOrg(),
            intent: 'reconnect',
        } as never);
        const row = await rowOf(started.authorizationId);
        expect(row).toMatchObject({ user_id: ALICE.id, org_id: ORG, intent: 'connect' });
    });

    it('rejects a context the board did not mint', async () => {
        const r = rig();
        const forged = {
            orgId: ORG,
            principal: { kind: 'user', userId: ALICE.id },
            initiator: { kind: 'user', userId: ALICE.id },
        };
        await expect(r.flow.startAuthorization(forged as never, { provider: 'jira' })).rejects.toThrow();
        await expect(r.flow.completeAuthorization(forged as never, { state: 'x' })).rejects.toThrow();
    });

    it('stores `/` for a protocol-relative, absolute or missing return path, and keeps a same-origin one', async () => {
        const r = rig();
        for (const returnTo of ['//evil.test/x', 'https://evil.test/x', undefined]) {
            const started = await begin(
                r,
                returnTo === undefined ? { provider: 'jira' } : { provider: 'jira', returnTo }
            );
            expect((await rowOf(started.authorizationId)).return_to).toBe('/');
        }
        const kept = await begin(r, { provider: 'jira', returnTo: '/settings?tab=integrations' });
        expect((await rowOf(kept.authorizationId)).return_to).toBe('/settings?tab=integrations');
    });

    it('refuses an unknown provider, an unconfigured one, a null callback origin, a foreign reconnect target and a bad interaction id', async () => {
        const r = rig();
        const count = async () =>
            Number((await db.sql<{ n: string }[]>`select count(*)::text as n from integration_authorization`)[0]!.n);
        expect(await r.flow.startAuthorization(asAlice(), { provider: 'nope' })).toEqual({
            ok: false,
            reason: 'unknown-provider',
        });
        expect(await r.flow.startAuthorization(asAlice(), { provider: 'noclient' })).toEqual({
            ok: false,
            reason: 'not-configured',
        });
        const noOrigin = rig({ callbackOrigin: null });
        expect(await noOrigin.flow.startAuthorization(asAlice(), { provider: 'jira' })).toEqual({
            ok: false,
            reason: 'not-configured',
        });
        const bobs = await seedConnected(r, { userId: BOB.id });
        const mine = await seedConnected(r);
        expect(
            await r.flow.startAuthorization(asAlice(), { provider: 'jira', connectionId: bobs.connectionId })
        ).toEqual({
            ok: false,
            reason: 'not-found',
        });
        expect(await r.flow.startAuthorization(asAlice(), { provider: 'jira', connectionId: randomUUID() })).toEqual({
            ok: false,
            reason: 'not-found',
        });
        await createConnectionStore({ sql: db.sql, orgId: ORG }).disconnect(mine.connectionId, {
            userId: ALICE.id,
        });
        expect(
            await r.flow.startAuthorization(asAlice(), { provider: 'jira', connectionId: mine.connectionId })
        ).toEqual({
            ok: false,
            reason: 'not-found',
        });
        expect(await r.flow.startAuthorization(asAlice(), { provider: 'jira', interactionId: 'not-a-uuid' })).toEqual({
            ok: false,
            reason: 'bad-input',
        });
        expect(await count()).toBe(0);
    });
});

describe.skipIf(!enabled)('complete: callback validation', () => {
    it('an unknown or missing state is state-mismatch with returnTo `/` and no exchange', async () => {
        const r = rig();
        expect(await complete(r, { state: 'nope', code: CODE })).toEqual({
            ok: false,
            returnTo: '/',
            failure: 'state-mismatch',
        });
        expect(await complete(r, { code: CODE })).toEqual({ ok: false, returnTo: '/', failure: 'state-mismatch' });
        expect(r.fake.exchangeCalls).toBe(0);
    });

    it("another user's context is refused and does not consume; the original user then completes", async () => {
        const r = rig();
        const started = await begin(r, { provider: 'jira', returnTo: '/after' });
        expect(await complete(r, { state: started.state, code: CODE }, asBob())).toEqual({
            ok: false,
            returnTo: '/',
            failure: 'state-mismatch',
        });
        expect(await rowOf(started.authorizationId)).toMatchObject({ status: 'pending', consumed_at: null });
        expect(r.fake.exchangeCalls).toBe(0);
        expect(await complete(r, { state: started.state, code: CODE })).toMatchObject({ ok: true, returnTo: '/after' });
    });

    it('a replayed callback is `replayed` and exchanges nothing more', async () => {
        const r = rig();
        r.fake.identity = { ...r.fake.identity!, externalAccountId: acctId() };
        const started = await begin(r, { provider: 'jira', returnTo: '/after' });
        expect(await complete(r, { state: started.state, code: CODE })).toMatchObject({ ok: true });
        expect(await complete(r, { state: started.state, code: CODE })).toEqual({
            ok: false,
            returnTo: '/after',
            failure: 'replayed',
        });
        expect(r.fake.exchangeCalls).toBe(1);
        expect(r.fake.discoverCalls).toBe(1);
    });

    it('two concurrent completions of one state: exactly one exchanges', async () => {
        const r = rig();
        r.fake.identity = { ...r.fake.identity!, externalAccountId: acctId() };
        const started = await begin(r);
        const gate = parked();
        const holder = db.sql.begin(async (tx) => {
            await tx`select id from integration_authorization where id = ${started.authorizationId} for update`;
            await gate.hold();
        });
        await gate.entered;
        const first = complete(r, { state: started.state, code: CODE });
        const second = complete(r, { state: started.state, code: CODE });
        let settled = false;
        void Promise.all([first, second]).then(() => {
            settled = true;
        });
        expect(await waitForLockWaiters(db.sql, 2, () => settled)).toBe('blocked');
        gate.release();
        await holder;
        const results = await Promise.all([first, second]);
        expect(results.filter((x) => x.ok)).toHaveLength(1);
        expect(results.filter((x) => !x.ok)).toEqual([{ ok: false, returnTo: '/', failure: 'replayed' }]);
        expect(r.fake.exchangeCalls).toBe(1);
    });

    it('an expired transaction is `expired` and exchanges nothing', async () => {
        const r = rig();
        const started = await begin(r, { provider: 'jira', returnTo: '/after' });
        await db.sql`update integration_authorization set expires_at = now() - interval '1 second' where id = ${started.authorizationId}`;
        expect(await complete(r, { state: started.state, code: CODE })).toEqual({
            ok: false,
            returnTo: '/after',
            failure: 'expired',
        });
        expect(await rowOf(started.authorizationId)).toMatchObject({ status: 'expired', failure: 'expired' });
        expect(r.fake.exchangeCalls).toBe(0);
    });

    it('denied consent is failed/denied, consumed, with no exchange', async () => {
        const r = rig();
        const started = await begin(r, { provider: 'jira', returnTo: '/after' });
        expect(await complete(r, { state: started.state, error: 'access_denied' })).toEqual({
            ok: false,
            returnTo: '/after',
            failure: 'denied',
        });
        const row = await rowOf(started.authorizationId);
        expect(row).toMatchObject({ status: 'failed', failure: 'denied', pkce_verifier: null });
        expect(row.consumed_at).not.toBeNull();
        expect(r.fake.exchangeCalls).toBe(0);
    });

    it('answers the stored return path, never a query-supplied one', async () => {
        const r = rig();
        r.fake.identity = { ...r.fake.identity!, externalAccountId: acctId() };
        const started = await begin(r, { provider: 'jira', returnTo: '/stored' });
        const done = await complete(r, { state: started.state, code: CODE, returnTo: 'https://evil.test/' } as never);
        expect(done).toMatchObject({ ok: true, returnTo: '/stored' });
    });

    it('the PKCE verifier reaches the exchange and is nulled once the row is consumed', async () => {
        const r = rig();
        r.fake.identity = { ...r.fake.identity!, externalAccountId: acctId() };
        const started = await begin(r);
        const verifier = (await rowOf(started.authorizationId)).pkce_verifier;
        expect(verifier).toEqual(expect.any(String));
        await complete(r, { state: started.state, code: CODE });
        expect(r.fake.lastExchange).toMatchObject({ code: CODE, codeVerifier: verifier });
        expect((await rowOf(started.authorizationId)).pkce_verifier).toBeNull();
    });
});

describe.skipIf(!enabled)('complete: one lineage, claimed before the exchange', () => {
    it('a reconnect with a refresh parked is busy and its code is never exchanged; the refresh then finalizes', async () => {
        const r = rig();
        const seeded = await seedConnected(r);
        const refreshGate = r.fake.parkNext();
        const refreshing = r.lineage.refreshGrant(seeded.grantId);
        await refreshGate.accepted;
        const started = await begin(r, { provider: 'jira', connectionId: seeded.connectionId });
        expect(await complete(r, { state: started.state, code: CODE })).toEqual({
            ok: false,
            returnTo: '/',
            failure: 'busy',
        });
        expect(r.fake.exchangeCalls).toBe(0);
        expect(await rowOf(started.authorizationId)).toMatchObject({ status: 'failed', failure: 'busy' });
        refreshGate.release();
        expect(await refreshing).toEqual({ ok: true });
        expect(await grantOf(seeded.grantId)).toMatchObject({ status: 'active', version: '2', lineage_claim: null });
    });

    it('a refresh while a reconnect holds the claim is refresh-in-progress and exchanges nothing', async () => {
        const r = rig();
        const seeded = await seedConnected(r);
        const started = await begin(r, { provider: 'jira', connectionId: seeded.connectionId });
        const exchangeGate = r.fake.parkExchange();
        const completing = complete(r, { state: started.state, code: CODE });
        await exchangeGate.accepted;
        expect(await r.lineage.refreshGrant(seeded.grantId)).toEqual({
            ok: false,
            outcome: { outcome: 'unavailable', reason: 'refresh-in-progress', retryable: true },
        });
        expect(r.fake.refreshCalls).toBe(0);
        exchangeGate.release();
        expect(await completing).toMatchObject({ ok: true, connectionId: seeded.connectionId });
        expect(await grantOf(seeded.grantId)).toMatchObject({ status: 'active', version: '2', lineage_claim: null });
    });

    it('a connect that finds an existing grant with a refresh parked is busy after its exchange; the tokens are dropped', async () => {
        const r = rig({ revokeScope: 'token' });
        const seeded = await seedConnected(r);
        const refreshGate = r.fake.parkNext();
        const refreshing = r.lineage.refreshGrant(seeded.grantId);
        await refreshGate.accepted;
        const started = await begin(r);
        expect(await complete(r, { state: started.state, code: CODE })).toEqual({
            ok: false,
            returnTo: '/',
            failure: 'busy',
        });
        expect(r.fake.exchangeCalls).toBe(1);
        expect(r.fake.revoked).toEqual([]);
        expect(await grantOf(seeded.grantId)).toMatchObject({ version: '1', lineage_operation_id: null });
        refreshGate.release();
        expect(await refreshing).toEqual({ ok: true });
        expect(r.fake.refreshCalls).toBe(1);
        expect(r.fake.revoked).toEqual([]);
        const stored = await storedPayload(r, seeded.grantId);
        expect(stored.refreshToken).toBe(r.fake.issued[0]!.refreshToken);
        expect(stored.accessToken).toBe(r.fake.issued[0]!.accessToken);
    });

    it('a connect to an existing grant of the caller refreshes its credentials and adds the new resource', async () => {
        const r = rig();
        const seeded = await seedConnected(r);
        r.fake.identity = {
            ...r.fake.identity!,
            resources: [{ id: 'second-site', label: 'second.fake.test' }],
        };
        const started = await begin(r);
        const done = await complete(r, { state: started.state, code: CODE });
        expect(done).toMatchObject({ ok: true });
        expect(await grantsOfAccount(seeded.account)).toHaveLength(1);
        expect(await grantOf(seeded.grantId)).toMatchObject({ version: '2', lineage_claim: null });
        expect((await storedPayload(r, seeded.grantId)).accessToken).toBe('code-access-1');
        const clouds = (await connectionsOfAccount(seeded.account)).map((c) => c.cloud_id);
        expect(clouds).toHaveLength(2);
        expect(clouds).toContain('second-site');
    });

    it('a reconnect restores a reconnect_required grant to active', async () => {
        const r = rig();
        const seeded = await seedConnected(r, { status: 'reconnect_required' });
        const started = await begin(r, { provider: 'jira', connectionId: seeded.connectionId, returnTo: '/back' });
        expect(await rowOf(started.authorizationId)).toMatchObject({
            intent: 'reconnect',
            connection_id: seeded.connectionId,
            expected_account_id: seeded.account,
        });
        expect(await complete(r, { state: started.state, code: CODE })).toEqual({
            ok: true,
            returnTo: '/back',
            connectionId: seeded.connectionId,
        });
        expect(await grantOf(seeded.grantId)).toMatchObject({ status: 'active', version: '2', lineage_claim: null });
        expect(await storedPayload(r, seeded.grantId)).toMatchObject({
            accessToken: 'code-access-1',
            refreshToken: 'code-refresh-1',
        });
        expect(await rowOf(started.authorizationId)).toMatchObject({ status: 'completed', failure: null });
    });

    it('a reconnect to a different account is identity-mismatch: claim released, grant and connection unchanged, nothing revoked', async () => {
        const r = rig({ revokeScope: 'token' });
        const seeded = await seedConnected(r);
        r.fake.identity = { ...r.fake.identity!, externalAccountId: acctId() };
        const before = await grantOf(seeded.grantId);
        const started = await begin(r, { provider: 'jira', connectionId: seeded.connectionId });
        expect(await complete(r, { state: started.state, code: CODE })).toEqual({
            ok: false,
            returnTo: '/',
            failure: 'identity-mismatch',
        });
        expect(await grantOf(seeded.grantId)).toEqual({ ...before, lineage_claim: null });
        expect((await connectionsOfAccount(seeded.account)).map((c) => c.status)).toEqual(['active']);
        expect(r.fake.revoked).toEqual([]);
        expect(await rowOf(started.authorizationId)).toMatchObject({ status: 'failed', failure: 'identity-mismatch' });
    });

    it('an account already granted to another principal is grant-conflict: its grant untouched, nothing revoked', async () => {
        const r = rig({ revokeScope: 'token' });
        const bobs = await seedConnected(r, { userId: BOB.id });
        const before = await grantOf(bobs.grantId);
        const started = await begin(r);
        expect(await complete(r, { state: started.state, code: CODE })).toEqual({
            ok: false,
            returnTo: '/',
            failure: 'grant-conflict',
        });
        expect(await grantOf(bobs.grantId)).toEqual(before);
        expect(await grantsOfAccount(bobs.account)).toHaveLength(1);
        expect(r.fake.revoked).toEqual([]);
    });

    it('an unavailable identity lookup is failed/exchange-failed and leaves the held claim released', async () => {
        const r = rig();
        const seeded = await seedConnected(r);
        r.fake.identity = null;
        const started = await begin(r, { provider: 'jira', connectionId: seeded.connectionId });
        expect(await complete(r, { state: started.state, code: CODE })).toMatchObject({
            ok: false,
            failure: 'exchange-failed',
        });
        expect(await grantOf(seeded.grantId)).toMatchObject({ status: 'active', version: '1', lineage_claim: null });
    });
});

describe.skipIf(!enabled)('complete: a new grant is created secret first, connection last', () => {
    const newAccount = (r: Rig, resources = [{ id: 'acme', label: 'acme.fake.test' }]) => {
        const account = acctId();
        r.fake.identity = {
            externalAccountId: account,
            label: `${account}@example.test`,
            resources,
            authority: { scopes: ['fake:read'] },
        };
        return account;
    };

    it('the secret is created before the connection is visible, and the grant holds that secret', async () => {
        const gate = parked();
        const r = rig({
            store: (h) =>
                faultyStore(h, {
                    activate: async (run) => {
                        await gate.hold();
                        return run();
                    },
                }).store,
        });
        const account = newAccount(r);
        const started = await begin(r);
        const completing = complete(r, { state: started.state, code: CODE });
        await gate.entered;
        const mid = await rowOf(started.authorizationId);
        expect(mid).toMatchObject({ status: 'persisting' });
        expect(mid.pending_grant_id).toEqual(expect.any(String));
        expect(mid.secret_ref).toEqual(expect.any(String));
        expect(mid.secret_operation_id).toEqual(expect.any(String));
        expect(await createConnectionStore({ sql: db.sql, orgId: ORG }).list(ALICE.id)).toEqual([]);
        expect(await grantsOfAccount(account)).toHaveLength(0);
        gate.release();
        const done = await completing;
        expect(done).toMatchObject({ ok: true, returnTo: '/' });
        const [grant] = await grantsOfAccount(account);
        expect(grant).toMatchObject({ id: mid.pending_grant_id, secret_ref: mid.secret_ref, status: 'active' });
        const [connection] = await connectionsOfAccount(account);
        expect(connection).toMatchObject({
            status: 'active',
            credential: 'oauth_grant',
            grant_id: grant!.id,
            cloud_id: 'acme',
            site: 'acme.fake.test',
        });
        expect(done.ok && done.connectionId).toBe(connection!.id);
        expect(await storedPayload(r, grant!.id)).toMatchObject({
            accessToken: 'code-access-1',
            refreshToken: 'code-refresh-1',
            authority: { scopes: ['fake:read'] },
        });
        const row = await rowOf(started.authorizationId);
        expect(row).toMatchObject({ status: 'completed', failure: null });
        expect(row.result).toMatchObject({ connectionIds: [connection!.id] });
    });

    // Review r1 (A2): the authorization's own durable deadline covers the whole flow, not the refresh lease.
    it('exchange, discovery and persistence outlasting the refresh lease but inside the authorization deadline: recovery leaves it and the connect succeeds', async () => {
        const r = rig();
        const account = newAccount(r);
        const started = await begin(r);
        const discoverGate = r.fake.parkDiscover();
        const completing = complete(r, { state: started.state, code: CODE });
        await discoverGate.accepted;
        // The row was consumed longer ago than the 45 s refresh lease, but the whole flow may take longer.
        await db.sql`
            update integration_authorization
            set consumed_at = now() - (${r.lineage.leaseMs + 1000}::double precision * interval '1 millisecond')
            where id = ${started.authorizationId}
        `;
        expect(await r.flowOver().recoverAuthorization(started.authorizationId)).toBe('not-expired');
        expect(await rowOf(started.authorizationId)).toMatchObject({ status: 'exchanging' });
        discoverGate.release();
        expect(await completing).toMatchObject({ ok: true });
        expect(await grantsOfAccount(account)).toHaveLength(1);
        expect(await rowOf(started.authorizationId)).toMatchObject({ status: 'completed', failure: null });
    });

    it('the row records the deadline at consume: it covers both provider calls, the persistence budget and a margin', async () => {
        const r = rig({
            timing: { exchangeDeadlineMs: 1000, persistBudgetMs: 2000, marginMs: 500, readDeadlineMs: 0 },
        });
        newAccount(r);
        const started = await begin(r);
        const discoverGate = r.fake.parkDiscover();
        const completing = complete(r, { state: started.state, code: CODE });
        await discoverGate.accepted;
        const [window] = await db.sql<{ ms: number }[]>`
            select extract(epoch from (deadline_at - consumed_at)) * 1000 as ms
            from integration_authorization where id = ${started.authorizationId}
        `;
        expect(Number(window!.ms)).toBeGreaterThanOrEqual(2 * 1000 + 2000 + 500);
        discoverGate.release();
        await completing;
    });

    it('the live flow does not cross its deadline: a durable deadline that passed before the secret is recorded ends it interrupted, with nothing stored', async () => {
        const r = rig();
        const account = newAccount(r);
        const started = await begin(r);
        const discoverGate = r.fake.parkDiscover();
        const completing = complete(r, { state: started.state, code: CODE });
        await discoverGate.accepted;
        await db.sql`update integration_authorization set deadline_at = now() - interval '1 second' where id = ${started.authorizationId}`;
        discoverGate.release();
        expect(await completing).toEqual({ ok: false, returnTo: '/', failure: 'interrupted' });
        expect(await grantsOfAccount(account)).toHaveLength(0);
        expect(await rowOf(started.authorizationId)).toMatchObject({ status: 'failed', failure: 'interrupted' });
    });

    describe('with the process clock past the deadline', () => {
        afterEach(() => {
            vi.useRealTimers();
        });

        it('the live flow checks the deadline before each step: no identity lookup after an exchange that used the whole budget', async () => {
            const r = rig();
            const account = newAccount(r);
            const started = await begin(r);
            const exchangeGate = r.fake.parkExchange();
            const completing = complete(r, { state: started.state, code: CODE });
            await exchangeGate.accepted;
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(Date.now() + 10 * 60_000);
            exchangeGate.release();
            expect(await completing).toEqual({ ok: false, returnTo: '/', failure: 'interrupted' });
            vi.useRealTimers();
            expect(r.fake.discoverCalls).toBe(0);
            expect(await grantsOfAccount(account)).toHaveLength(0);
            expect(await rowOf(started.authorizationId)).toMatchObject({ status: 'failed', failure: 'interrupted' });
        });
    });

    it('recovery leaves a persistence attempt that is still live, even past the deadline, and the flow then completes', async () => {
        const hold = parked();
        const r = rig({
            store: (h) =>
                faultyStore(h, {
                    stageVersion: async (run) => {
                        await hold.hold();
                        return run();
                    },
                }).store,
        });
        const account = newAccount(r);
        const started = await begin(r);
        const completing = complete(r, { state: started.state, code: CODE });
        await hold.entered;
        expect(await rowOf(started.authorizationId)).toMatchObject({ status: 'persisting' });
        await lapse(started.authorizationId);
        expect(await r.flowOver().recoverAuthorization(started.authorizationId)).toBe('left');
        expect(await rowOf(started.authorizationId)).toMatchObject({ status: 'persisting', failure: null });
        hold.release();
        expect(await completing).toMatchObject({ ok: true });
        expect(await grantsOfAccount(account)).toHaveLength(1);
    });

    it('every discovered resource becomes a connection under the one grant', async () => {
        const r = rig();
        const account = newAccount(r, [
            { id: 'site-a', label: 'a.fake.test' },
            { id: 'site-b', label: 'b.fake.test' },
        ]);
        const started = await begin(r);
        expect(await complete(r, { state: started.state, code: CODE })).toMatchObject({ ok: true });
        const connections = await connectionsOfAccount(account);
        expect(connections.map((c) => c.cloud_id).sort()).toEqual(['site-a', 'site-b']);
        expect(new Set(connections.map((c) => c.grant_id)).size).toBe(1);
    });

    it('a create whose response was lost (applied) is replayed identically by the holder: one exchange, one operation', async () => {
        const spy = { current: undefined as unknown as ReturnType<typeof spied> };
        const r = rig({
            store: (h) => {
                spy.current = spied(faultyStore(h, { activate: throwAfterActivate }).store);
                return spy.current.store;
            },
        });
        const account = newAccount(r);
        const started = await begin(r);
        expect(await complete(r, { state: started.state, code: CODE })).toMatchObject({ ok: true });
        expect(r.fake.exchangeCalls).toBe(1);
        expect(spy.current.log.creates).toBeGreaterThanOrEqual(2);
        expect(new Set(spy.current.log.operationIds).size).toBe(1);
        expect(await grantsOfAccount(account)).toHaveLength(1);
    });

    it('a create never staged and a holder that crashed: recovery reconciles unknown to failed/storage-failed, no grant, one exchange', async () => {
        const r = rig({
            store: (h) => faultyStore(h, { stageVersion: throwBefore() }).store,
            timing: { persistBudgetMs: 0 },
        });
        const account = newAccount(r);
        const started = await begin(r);
        expect(await complete(r, { state: started.state, code: CODE })).toMatchObject({
            ok: false,
            failure: 'storage-failed',
        });
        expect(await rowOf(started.authorizationId)).toMatchObject({ status: 'persisting' });
        await lapse(started.authorizationId);
        const fresh = r.flowOver({ secrets: r.h.openWith(r.h.realRepo) });
        expect(await fresh.recoverAuthorization(started.authorizationId)).toBe('failed');
        expect(await rowOf(started.authorizationId)).toMatchObject({ status: 'failed', failure: 'storage-failed' });
        expect(await grantsOfAccount(account)).toHaveLength(0);
        expect(await connectionsOfAccount(account)).toHaveLength(0);
        expect(r.fake.exchangeCalls).toBe(1);
        expect(await fresh.recoverAuthorization(started.authorizationId)).toBe('idle');
    });

    it('a holder that crashed after an applied create: recovery reconciles succeeded and activates the grant and connection', async () => {
        const r = rig({
            store: (h) => faultyStore(h, { activate: throwAfterActivate }).store,
            timing: { persistBudgetMs: 0 },
        });
        const account = newAccount(r);
        const started = await begin(r);
        expect(await complete(r, { state: started.state, code: CODE })).toMatchObject({
            ok: false,
            failure: 'storage-failed',
        });
        expect(await grantsOfAccount(account)).toHaveLength(0);
        await lapse(started.authorizationId);
        const fresh = r.flowOver({ secrets: r.h.openWith(r.h.realRepo) });
        expect(await fresh.recoverAuthorization(started.authorizationId)).toBe('activated');
        const [grant] = await grantsOfAccount(account);
        expect(grant).toMatchObject({ status: 'active', secret_version: expect.any(String) });
        expect(await connectionsOfAccount(account)).toHaveLength(1);
        expect(await rowOf(started.authorizationId)).toMatchObject({ status: 'completed' });
        expect(r.fake.exchangeCalls).toBe(1);
        expect((await storedPayload(r, grant!.id)).accessToken).toBe('code-access-1');
    });

    it('recovery of an applied create whose account was granted meanwhile is grant-conflict and destroys our reference', async () => {
        const r = rig({
            store: (h) => faultyStore(h, { activate: throwAfterActivate }).store,
            timing: { persistBudgetMs: 0 },
        });
        const account = newAccount(r);
        const started = await begin(r);
        await complete(r, { state: started.state, code: CODE });
        const grants = createConnectionGrants({ sql: db.sql, orgId: ORG });
        const rival = await attachJira(grants, BOB.id, { externalAccountId: account, cloudId: 'rival-cloud' });
        await lapse(started.authorizationId);
        const spy = spied(r.h.openWith(r.h.realRepo));
        const fresh = r.flowOver({ secrets: spy.store });
        expect(await fresh.recoverAuthorization(started.authorizationId)).toBe('failed');
        expect(await rowOf(started.authorizationId)).toMatchObject({ status: 'failed', failure: 'grant-conflict' });
        expect(spy.log.deletes).toBe(1);
        expect(await grantsOfAccount(account)).toHaveLength(1);
        expect((await grantOf(rival.grant.id)).principal_user_id).toBe(BOB.id);
    });
});

describe.skipIf(!enabled)('complete: activation is idempotent over connected resources (review r1, C1)', () => {
    const second = async (account: string, cloudId: string) =>
        attachJira(createConnectionGrants({ sql: db.sql, orgId: ORG }), ALICE.id, {
            externalAccountId: account,
            cloudId,
        });

    it('A connected, a consent that discovers [A, B]: A is untouched (same id), B becomes active, one grant', async () => {
        const r = rig();
        const seeded = await seedConnected(r);
        const [a] = await connectionsOfAccount(seeded.account);
        r.fake.identity = {
            ...r.fake.identity!,
            resources: [
                { id: a!.cloud_id, label: a!.site },
                { id: 'site-b', label: 'b.fake.test' },
            ],
        };
        const started = await begin(r);
        const done = await complete(r, { state: started.state, code: CODE });
        expect(done).toMatchObject({ ok: true });
        const connections = await connectionsOfAccount(seeded.account);
        expect(connections.map((c) => c.cloud_id).sort()).toEqual([a!.cloud_id, 'site-b'].sort());
        expect(connections.find((c) => c.cloud_id === a!.cloud_id)).toMatchObject({ id: a!.id, status: 'active' });
        expect(connections.find((c) => c.cloud_id === 'site-b')).toMatchObject({ status: 'active' });
        expect(await grantsOfAccount(seeded.account)).toHaveLength(1);
        const row = await rowOf(started.authorizationId);
        expect(row).toMatchObject({ status: 'completed', failure: null });
        expect((row.result as { connectionIds: string[] }).connectionIds).toHaveLength(2);
    });

    it('a consent that discovers only connected resources completes with the existing connections', async () => {
        const r = rig();
        const seeded = await seedConnected(r);
        const [a] = await connectionsOfAccount(seeded.account);
        r.fake.identity = { ...r.fake.identity!, resources: [{ id: a!.cloud_id, label: a!.site }] };
        const started = await begin(r);
        expect(await complete(r, { state: started.state, code: CODE })).toMatchObject({
            ok: true,
            connectionId: a!.id,
        });
        expect(await connectionsOfAccount(seeded.account)).toHaveLength(1);
    });

    it('a previously disconnected resource stays disconnected when a later consent rediscovers it', async () => {
        const r = rig();
        const seeded = await seedConnected(r);
        const [a] = await connectionsOfAccount(seeded.account);
        const b = await second(seeded.account, 'site-b');
        const store = createConnectionStore({ sql: db.sql, orgId: ORG });
        expect((await store.disconnect(b.connectionId, { userId: ALICE.id })).disconnected).toBe(true);
        r.fake.identity = {
            ...r.fake.identity!,
            resources: [
                { id: a!.cloud_id, label: a!.site },
                { id: 'site-b', label: 'b.fake.test' },
                { id: 'site-c', label: 'c.fake.test' },
            ],
        };
        const started = await begin(r);
        expect(await complete(r, { state: started.state, code: CODE })).toMatchObject({ ok: true });
        const statuses = Object.fromEntries(
            (await connectionsOfAccount(seeded.account)).map((c) => [c.cloud_id, c.status])
        );
        expect(statuses).toEqual({ [a!.cloud_id]: 'active', 'site-b': 'disconnected', 'site-c': 'active' });
    });

    it('a consent whose every resource was disconnected is refused duplicate-connection and activates nothing', async () => {
        const r = rig();
        const seeded = await seedConnected(r);
        const b = await second(seeded.account, 'site-b');
        const store = createConnectionStore({ sql: db.sql, orgId: ORG });
        expect((await store.disconnect(b.connectionId, { userId: ALICE.id })).disconnected).toBe(true);
        r.fake.identity = { ...r.fake.identity!, resources: [{ id: 'site-b', label: 'b.fake.test' }] };
        const started = await begin(r);
        expect(await complete(r, { state: started.state, code: CODE })).toMatchObject({
            ok: false,
            failure: 'duplicate-connection',
        });
        expect((await connectionsOfAccount(seeded.account)).filter((c) => c.status === 'active')).toHaveLength(1);
    });
});

describe.skipIf(!enabled)('complete: review r2, a create paused before or after the store saw it', () => {
    const newAccount = (r: Rig) => {
        const account = acctId();
        r.fake.identity = {
            externalAccountId: account,
            label: `${account}@example.test`,
            resources: [{ id: 'acme', label: 'acme.fake.test' }],
            authority: { scopes: ['fake:read'] },
        };
        return account;
    };
    /** Another process over the same store: its own lineage (so its own attempt registry) and flow. */
    const otherProcess = (a: Rig) => {
        const secrets = a.h.openWith(a.h.realRepo);
        const lineage = createGrantLineage({
            sql: db.sql,
            orgId: ORG,
            secrets,
            providers: (provider) => (provider === 'jira' ? a.fake.hooks : undefined),
            timing: { retryDelayMs: 0 },
        });
        return createAuthorizationFlow({
            sql: db.sql,
            orgId: ORG,
            secrets,
            lineage,
            providers: (provider) => (provider === 'jira' ? a.fake.hooks : undefined),
            clients: (provider) =>
                provider === 'jira' ? { clientId: 'client-1', scopesFor: () => ['fake:read'] } : undefined,
            callbackOrigin: 'https://board.example.test',
        });
    };
    const referenceOf = async (id: string) => {
        const row = await rowOf(id);
        return {
            identity: grantSecretIdentity({ id: row.pending_grant_id!, orgId: ORG, principalUserId: ALICE.id }),
            ref: row.secret_ref as SecretRef,
        };
    };

    it('paused before the store call: recovery fences the operation, the late create is refused and no reference exists', async () => {
        const gate = parked();
        const a = rig({ store: (h) => parkBeforeStore(h.open(), 'create', gate) });
        const account = newAccount(a);
        const started = await begin(a);
        const completing = complete(a, { state: started.state, code: CODE });
        await gate.entered;
        expect(await rowOf(started.authorizationId)).toMatchObject({ status: 'persisting' });
        await lapse(started.authorizationId);

        const b = otherProcess(a);
        expect(await b.recoverAuthorization(started.authorizationId)).toBe('failed');
        expect(await rowOf(started.authorizationId)).toMatchObject({ status: 'failed', failure: 'storage-failed' });

        gate.release();
        expect(await completing).toMatchObject({ ok: false });
        expect(await a.h.open().readActive(await referenceOf(started.authorizationId))).toMatchObject({
            ok: false,
            error: { code: 'not-found' },
        });
        expect(await grantsOfAccount(account)).toHaveLength(0);
        expect(await connectionsOfAccount(account)).toHaveLength(0);
    });

    it('paused after the intent was inserted: the fence loses the race, the late activation is refused, no grant and no connection', async () => {
        const gate = parked();
        const a = rig({
            store: (h) =>
                faultyStore(h, {
                    insertIntent: async (run) => {
                        const row = await run();
                        await gate.hold();
                        return row;
                    },
                }).store,
        });
        const account = newAccount(a);
        const started = await begin(a);
        const completing = complete(a, { state: started.state, code: CODE });
        await gate.entered;
        await lapse(started.authorizationId);

        const b = otherProcess(a);
        expect(await b.recoverAuthorization(started.authorizationId)).toBe('failed');
        gate.release();
        expect(await completing).toMatchObject({ ok: false });
        expect(await rowOf(started.authorizationId)).toMatchObject({ status: 'failed', failure: 'storage-failed' });
        expect(await grantsOfAccount(account)).toHaveLength(0);
        expect(await connectionsOfAccount(account)).toHaveLength(0);
    });
});

describe.skipIf(!enabled)('complete: recovery of a stuck transaction and cancellation', () => {
    it('a transaction stuck exchanging past its time is failed/interrupted, never re-exchanged; a held rotating reconsent claim goes to reconnect_required', async () => {
        const r = rig({ rotates: true });
        const seeded = await seedConnected(r);
        const started = await begin(r, { provider: 'jira', connectionId: seeded.connectionId });
        const exchangeGate = r.fake.parkExchange();
        const stuck = complete(r, { state: started.state, code: CODE });
        await exchangeGate.accepted;
        expect(await grantOf(seeded.grantId)).toMatchObject({ lineage_claim: expect.any(String) });
        await lapse(started.authorizationId);
        const other = r.flowOver();
        expect(await other.recoverAuthorization(started.authorizationId)).toBe('interrupted');
        expect(await rowOf(started.authorizationId)).toMatchObject({ status: 'failed', failure: 'interrupted' });
        expect(await grantOf(seeded.grantId)).toMatchObject({ status: 'reconnect_required', lineage_claim: null });
        expect(r.fake.exchangeCalls).toBe(1);
        exchangeGate.release('invalid_grant');
        expect(await stuck).toMatchObject({ ok: false });
        expect(await rowOf(started.authorizationId)).toMatchObject({ status: 'failed', failure: 'interrupted' });
        expect(r.fake.exchangeCalls).toBe(1);
    });

    it('the same recovery on a non-rotating provider releases the claim and leaves the grant active', async () => {
        const r = rig({ rotates: false });
        const seeded = await seedConnected(r);
        const started = await begin(r, { provider: 'jira', connectionId: seeded.connectionId });
        const exchangeGate = r.fake.parkExchange();
        const stuck = complete(r, { state: started.state, code: CODE });
        await exchangeGate.accepted;
        await lapse(started.authorizationId);
        expect(await r.flowOver().recoverAuthorization(started.authorizationId)).toBe('interrupted');
        expect(await grantOf(seeded.grantId)).toMatchObject({ status: 'active', lineage_claim: null });
        exchangeGate.release('invalid_grant');
        await stuck;
    });

    it('recovery leaves a transaction that is not yet past its time, and expires an unconsumed one', async () => {
        const r = rig();
        const live = await begin(r);
        expect(await r.flow.recoverAuthorization(live.authorizationId)).toBe('not-expired');
        await db.sql`update integration_authorization set expires_at = now() - interval '1 second' where id = ${live.authorizationId}`;
        expect(await r.flow.recoverAuthorization(live.authorizationId)).toBe('expired');
        expect(await rowOf(live.authorizationId)).toMatchObject({ status: 'expired', failure: 'expired' });
    });

    it('a cancel after the provider accepted the code of a rotating reconnect: failed/exchange-failed and the grant needs a reconnect', async () => {
        const r = rig({ rotates: true });
        const seeded = await seedConnected(r);
        const started = await begin(r, { provider: 'jira', connectionId: seeded.connectionId });
        const exchangeGate = r.fake.parkExchange();
        const controller = new AbortController();
        const completing = complete(r, { state: started.state, code: CODE }, asAlice(), controller.signal);
        await exchangeGate.accepted;
        controller.abort();
        expect(await completing).toEqual({ ok: false, returnTo: '/', failure: 'exchange-failed' });
        expect(await grantOf(seeded.grantId)).toMatchObject({ status: 'reconnect_required', lineage_claim: null });
    });

    it('a cancel before dispatch releases the claim without touching the grant', async () => {
        const r = rig({ rotates: true });
        const seeded = await seedConnected(r);
        const started = await begin(r, { provider: 'jira', connectionId: seeded.connectionId });
        const controller = new AbortController();
        controller.abort();
        expect(await complete(r, { state: started.state, code: CODE }, asAlice(), controller.signal)).toEqual({
            ok: false,
            returnTo: '/',
            failure: 'exchange-failed',
        });
        expect(r.fake.exchangeCalls).toBe(0);
        expect(await grantOf(seeded.grantId)).toMatchObject({ status: 'active', version: '1', lineage_claim: null });
    });

    it('a cancel after the exchange succeeded is detached: the credentials are still stored and the connection created', async () => {
        const r = rig();
        const account = acctId();
        r.fake.identity = {
            externalAccountId: account,
            label: `${account}@example.test`,
            resources: [{ id: 'acme', label: 'a' }],
            authority: { scopes: ['fake:read'] },
        };
        const started = await begin(r);
        const discoverGate = r.fake.parkDiscover();
        const controller = new AbortController();
        const completing = complete(r, { state: started.state, code: CODE }, asAlice(), controller.signal);
        await discoverGate.accepted;
        controller.abort();
        discoverGate.release();
        expect(await completing).toMatchObject({ ok: true });
        const [grant] = await grantsOfAccount(account);
        expect((await storedPayload(r, grant!.id)).accessToken).toBe('code-access-1');
        expect(await connectionsOfAccount(account)).toHaveLength(1);
    });
});

describe.skipIf(!enabled)('redaction', () => {
    const SECRETS = [CODE, 'client-secret-XYZ', 'code-access-1', 'code-refresh-1', 'access-seed'];

    it('codes, state, verifier, tokens and the client secret reach no log, error, result or return value', async () => {
        const r = rig({
            hooks: (fake) => ({
                ...fake.hooks,
                exchangeCode: async (input) => {
                    if (input.code.endsWith('-throws')) throw new Error(`boom ${input.code} client-secret-XYZ`);
                    return fake.hooks.exchangeCode(input);
                },
            }),
        });
        const seen: unknown[] = [];
        const account = acctId();
        r.fake.identity = {
            externalAccountId: account,
            label: `${account}@example.test`,
            resources: [{ id: 'acme', label: 'a' }],
            authority: { scopes: ['fake:read'] },
        };
        const ok = await begin(r);
        const thrown = await begin(r);
        const denied = await begin(r);
        const verifiers = await Promise.all(
            [ok, thrown, denied].map(async (s) => (await rowOf(s.authorizationId)).pkce_verifier!)
        );
        seen.push(await complete(r, { state: ok.state, code: CODE }));
        seen.push(await complete(r, { state: thrown.state, code: `${CODE}-throws` }));
        seen.push(await complete(r, { state: denied.state, error: 'access_denied' }));
        seen.push(await complete(r, { state: ok.state, code: CODE }));
        for (const id of [ok, thrown, denied].map((s) => s.authorizationId)) seen.push(await rowOf(id));
        seen.push(r.flowEvents, r.lineageEvents);
        const text = JSON.stringify(seen);
        for (const secret of [...SECRETS, ok.state, thrown.state, denied.state, ...verifiers]) {
            expect(text).not.toContain(secret);
        }
        expect(r.flowEvents.length).toBeGreaterThan(0);
        for (const event of r.flowEvents) {
            expect(Object.keys(event).sort()).toEqual(expect.arrayContaining(['event']));
            expect(Object.keys(event).every((k) => ['event', 'authorizationId', 'failure'].includes(k))).toBe(true);
        }
    });
});
