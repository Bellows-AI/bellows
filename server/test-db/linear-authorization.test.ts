import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { createConnectionStore } from '../src/db/connection-store.js';
import { createIntegrationRuntime, type IntegrationRuntime } from '../src/integrations/integration-recovery.js';
import { linearRegistration } from '../src/integrations/providers/linear.js';
import { contextOfSession } from '../src/integrations/trusted-context.js';
import type { SecretStore } from '../src/secrets/secret-store.js';
import { testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';
import { lineageHarness } from './integration-store-faults.js';

/**
 * The Linear connect flow end to end on a database: the real runtime composed as main.ts does it, the real Linear
 * hooks over a scripted Linear (a fake fetch, the only boundary faked). The first database coverage of a provider
 * that rotates every refresh token and revokes a token at the provider (`revokeScope: 'token'`).
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const ALICE = testUser('linear-alice');
const db = useTestDb({ orgs: [ORG], users: [ALICE], max: 8 });

const BOARD = 'https://board.example.test';
const API = 'https://api.linear.example.test';
const WORKSPACE = 'lane-workspace';
const SHORT_LIVED_SECONDS = 30;

const newTag = (): string => randomUUID().slice(0, 8);
const viewerOf = (tag: string): string => `viewer-${tag}`;
const orgOf = (tag: string): string => `org-${tag}`;

interface Script {
    tag: string;
    /** The token answer's scope; Linear may send a comma string or an array. */
    scope?: string | string[];
    revokeStatus?: number;
}

/** A scripted Linear for one account: token (code and refresh, rotating), viewer, revoke. */
function scriptedLinear(initial: Script) {
    let script = initial;
    let issued = 0;
    const seen = { verifiers: [] as string[], refreshTokens: [] as string[], revoked: [] as string[] };
    const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = String(input);
        if (url === `${API}/oauth/token`) {
            const form = new URLSearchParams(String(init.body));
            const refresh = form.get('grant_type') === 'refresh_token';
            if (refresh) seen.refreshTokens.push(form.get('refresh_token') ?? '');
            else seen.verifiers.push(form.get('code_verifier') ?? '');
            issued += 1;
            return json(200, {
                access_token: `${script.tag}-access-${issued}`,
                token_type: 'Bearer',
                expires_in: SHORT_LIVED_SECONDS,
                refresh_token: `${script.tag}-refresh-${issued}`,
                scope: script.scope ?? 'read',
            });
        }
        if (url === `${API}/graphql`) {
            return json(200, {
                data: {
                    viewer: {
                        id: viewerOf(script.tag),
                        name: `Name ${script.tag}`,
                        email: `${script.tag}@example.com`,
                        organization: { id: orgOf(script.tag), name: 'Lane Workspace', urlKey: WORKSPACE },
                    },
                },
            });
        }
        if (url === `${API}/oauth/revoke`) {
            seen.revoked.push(new URLSearchParams(String(init.body)).get('token') ?? '');
            return new Response(null, { status: script.revokeStatus ?? 200 });
        }
        return json(404, { error: 'unscripted' });
    }) as typeof fetch;
    return { fetchFn, seen, rescript: (next: Script) => (script = next) };
}

/** A secret store whose reads can be made to time out, for the unconfirmed-read case. */
function readGate(store: SecretStore) {
    const gate = { failReads: false };
    const wrapped: SecretStore = {
        issueOperationId: () => store.issueOperationId(),
        create: (input) => store.create(input),
        readActive: (input) =>
            gate.failReads ? Promise.reject(new Error('read deadline exceeded')) : store.readActive(input),
        replace: (input) => store.replace(input),
        delete: (input) => store.delete(input),
        reconcileOperation: (input) => store.reconcileOperation(input),
    };
    return { store: wrapped, gate };
}

function linearRuntime(sql: Sql, fetchFn: typeof fetch, secrets: SecretStore = lineageHarness(sql).open()) {
    const registry = linearRegistration(
        {
            clientId: 'linear-client-1',
            clientSecret: 'linear-secret-1',
            authorizeUrl: `${BOARD}/stub/authorize`,
            apiOrigin: API,
        },
        BOARD,
        fetchFn
    );
    return createIntegrationRuntime({
        sql,
        crossOrgSql: sql,
        secrets,
        providers: registry.providers,
        clients: registry.clients,
        callbackOrigin: BOARD,
        timing: { retryDelayMs: 0 },
    });
}

async function begin(runtime: IntegrationRuntime, input: { access?: 'read' | 'write'; connectionId?: string } = {}) {
    const ctx = contextOfSession({ user: { id: ALICE.id } }, ORG);
    const flow = runtime.flowOf(ORG);
    const started = await flow.startAuthorization(ctx, { provider: 'linear', ...input });
    if (!started.ok) throw new Error(`start refused: ${started.reason}`);
    const url = new URL(started.authorizeUrl);
    const state = url.searchParams.get('state')!;
    return {
        url,
        complete: () => flow.completeAuthorization(ctx, { state, code: 'code-1' }),
    };
}

const connectionsOf = (tag: string) =>
    db.sql<{ id: string; kind: string; access: string; site: string; cloud_id: string; grant_id: string }[]>`
        select id, kind, access, site, cloud_id, grant_id from connector_connection
        where external_account_id = ${viewerOf(tag)}
    `;

const grantsOf = (tag: string) =>
    db.sql<
        {
            id: string;
            provider: string;
            status: string;
            authority: { scopes: string[] };
            secret_version: string | null;
            lineage_claim: string | null;
        }[]
    >`
        select id, provider, status, authority, secret_version, lineage_claim from integration_grant
        where external_account_id = ${viewerOf(tag)}
    `;

async function connected(scope: Script['scope'] = 'read') {
    const tag = newTag();
    const linear = scriptedLinear({ tag, scope });
    const secrets = readGate(lineageHarness(db.sql).open());
    const runtime = linearRuntime(db.sql, linear.fetchFn, secrets.store);
    expect(await (await begin(runtime)).complete()).toMatchObject({ ok: true });
    const [connection] = await connectionsOf(tag);
    return { tag, linear, runtime, secrets, connection: connection!, grantId: connection!.grant_id };
}

describe.skipIf(!enabled)('linear authorization', () => {
    it('connect makes a linear grant and a linear connection for the workspace, keyed by the organization id', async () => {
        const { tag, connection } = await connected();
        expect(connection).toMatchObject({ kind: 'linear', site: WORKSPACE, cloud_id: orgOf(tag), access: 'read' });
        const [grant] = await grantsOf(tag);
        expect(grant).toMatchObject({ provider: 'linear', status: 'active', authority: { scopes: ['read'] } });
    });

    it('the PKCE verifier of the S256 challenge reaches the exchange', async () => {
        const tag = newTag();
        const linear = scriptedLinear({ tag });
        const started = await begin(linearRuntime(db.sql, linear.fetchFn));
        expect(started.url.searchParams.get('code_challenge_method')).toBe('S256');
        expect(await started.complete()).toMatchObject({ ok: true });
        const [verifier] = linear.seen.verifiers;
        expect(verifier).toBeTruthy();
        expect(createHash('sha256').update(verifier!).digest('base64url')).toBe(
            started.url.searchParams.get('code_challenge')
        );
    });

    it('write consent asked but a token without write gives a read connection', async () => {
        const tag = newTag();
        const started = await begin(linearRuntime(db.sql, scriptedLinear({ tag, scope: 'read' }).fetchFn), {
            access: 'write',
        });
        expect(started.url.searchParams.get('scope')).toBe('read,write');
        expect(await started.complete()).toMatchObject({ ok: true });
        expect((await connectionsOf(tag)).map((c) => c.access)).toEqual(['read']);
    });

    it('a write grant, its scope as a comma string or an array, gives a write connection', async () => {
        for (const scope of ['read,write', ['read', 'write']]) {
            const tag = newTag();
            const runtime = linearRuntime(db.sql, scriptedLinear({ tag, scope }).fetchFn);
            expect(await (await begin(runtime, { access: 'write' })).complete()).toMatchObject({ ok: true });
            expect((await connectionsOf(tag)).map((c) => c.access)).toEqual(['write']);
            expect((await grantsOf(tag))[0]!.authority.scopes).toEqual(['read', 'write']);
        }
    });

    it('a reconnect as another Linear user is identity-mismatch and changes nothing', async () => {
        const { tag, linear, runtime, connection } = await connected();
        const before = await grantsOf(tag);
        const reconnect = await begin(runtime, { connectionId: connection.id });
        const other = newTag();
        linear.rescript({ tag: other });
        expect(await reconnect.complete()).toMatchObject({ ok: false, failure: 'identity-mismatch' });
        expect(await grantsOf(tag)).toEqual(before);
        expect(await connectionsOf(tag)).toEqual([connection]);
        expect(await grantsOf(other)).toHaveLength(0);
    });

    it('a refresh rotates: each refresh sends the refresh token the previous answer issued', async () => {
        const { tag, linear, runtime, grantId } = await connected();
        const lineage = runtime.lineageOf(ORG);
        expect(await lineage.refreshGrant(grantId)).toEqual({ ok: true });
        expect(await lineage.refreshGrant(grantId)).toEqual({ ok: true });
        expect(linear.seen.refreshTokens).toEqual([`${tag}-refresh-1`, `${tag}-refresh-2`]);
    });

    it('disconnecting the last connection revokes the grant and the stored refresh token once, then deletes the secret', async () => {
        const { tag, linear, runtime, connection, grantId } = await connected();
        expect(await runtime.lineageOf(ORG).refreshGrant(grantId)).toEqual({ ok: true });
        const store = createConnectionStore({ sql: db.sql, orgId: ORG });
        const removed = await store.disconnect(connection.id, { userId: ALICE.id });
        expect(removed).toMatchObject({ disconnected: true, revokedGrantId: grantId });
        expect(await runtime.destroyRevokedSecret(ORG, grantId)).toEqual({ ok: true });
        expect(linear.seen.revoked).toEqual([`${tag}-refresh-2`]);
        expect(await grantsOf(tag)).toMatchObject([{ status: 'revoked', secret_version: null, lineage_claim: null }]);
    });

    it('a revoke the provider refuses still deletes the secret', async () => {
        const { tag, linear, runtime, connection, grantId } = await connected();
        linear.rescript({ tag, revokeStatus: 400 });
        await createConnectionStore({ sql: db.sql, orgId: ORG }).disconnect(connection.id, { userId: ALICE.id });
        expect(await runtime.destroyRevokedSecret(ORG, grantId)).toEqual({ ok: true });
        expect(linear.seen.revoked).toEqual([`${tag}-refresh-1`]);
        expect(await grantsOf(tag)).toMatchObject([{ status: 'revoked', secret_version: null }]);
    });

    it('a revoke is never attempted on an unconfirmed secret read, and the secret is kept', async () => {
        const { tag, linear, runtime, secrets, connection, grantId } = await connected();
        await createConnectionStore({ sql: db.sql, orgId: ORG }).disconnect(connection.id, { userId: ALICE.id });
        secrets.gate.failReads = true;
        expect(await runtime.destroyRevokedSecret(ORG, grantId)).toEqual({ ok: false, reason: 'unconfirmed' });
        expect(linear.seen.revoked).toEqual([]);
        const [grant] = await grantsOf(tag);
        expect(grant).toMatchObject({ status: 'revoked' });
        expect(grant!.secret_version).not.toBeNull();
    });
});
