import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildApp } from '../src/app.js';
import { hashToken } from '../src/auth/session.js';
import { createAuthStore } from '../src/auth/store.js';
import { decodeEnvSecret, EnvSecretError } from '../src/db/env-secrets.js';
import {
    createForgeConnectionStore,
    type ForgeConnectionStore,
    gitlabConnectionIdentity,
    sweepRemovedConnections,
} from '../src/db/forge-connections.js';
import { createGitlabApi } from '../src/gitlab/gitlab-api.js';
import { createOrgRegistry } from '../src/orgs.js';
import type { SecretIdentity, SecretRef, SecretStore } from '../src/secrets/secret-store.js';
import { githubAuth, testConfig } from '../test/helpers-config.js';
import { failingPoolQuery, faultySecrets, testSecretStore } from './env-secrets-harness.js';
import { createPostgresHarness, dbError, MutableKeys } from './secrets-postgres-harness.js';
import { type FakeGitlab, startFakeGitlab } from './fake-gitlab.js';
import { randomGithubId, testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * An org's GitLab connection, pending until part 3 activates it (docs/connections.md): the store against the fake
 * GitLab for the reachability probe, and the admin routes through the real app, so the isolation shown is the
 * real per-org resolution.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb();
const PATH = '/api/org/gitlab-connections';
const OK = 200;
const CREATED = 201;
const BAD_REQUEST = 400;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const CONFLICT = 409;
interface ApiBody {
    id: string;
    code?: string;
    connections: { id: string }[];
    [field: string]: unknown;
}
const CA_PEM = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';

let sql: Sql;
let secrets: SecretStore;
let gitlab: FakeGitlab;
let fakeHost: string;
/** Any `*.gitlab.test` name reaches the fake: one instance stands for every host a test connects. */
const host = 'main.gitlab.test';
const named = (label: string) => `${label}.gitlab.test`;
let orgA: string;
let orgB: string;
let storeA: ForgeConnectionStore;
let storeB: ForgeConnectionStore;
let app: FastifyInstance;
let adminA: string;
let memberA: string;
let adminB: string;

const gitlabApi = () =>
    createGitlabApi({ baseUrl: (h) => `http://${h.endsWith('.gitlab.test') ? fakeHost : h}`, probeTimeoutMs: 400 });
const storeOf = (orgId: string, store: SecretStore = secrets) =>
    createForgeConnectionStore({ sql, orgId, secrets: store, secretLog: () => {}, gitlab: gitlabApi() });

const input = (over: Record<string, unknown> = {}) => ({
    host,
    clientId: `app-${randomUUID()}`,
    clientSecret: `secret-${randomUUID()}`,
    allowedGroups: ['platform'],
    ...over,
});

const rowOf = async (id: string) => {
    const [row] = await sql<
        { secret_ref: string; secret_version: string; ca_secret_ref: string | null; ca_secret_version: string | null }[]
    >`select secret_ref, secret_version, ca_secret_ref, ca_secret_version from forge_connection where id = ${id}`;
    return row;
};
const readSecret = async (orgId: string, id: string, part: 'client-secret' | 'ca-bundle', ref: string) => {
    const answer = await secrets.readActive({
        identity: gitlabConnectionIdentity(orgId, id, part),
        ref: ref as SecretRef,
    });
    return answer.ok ? decodeEnvSecret(answer.value) : `${answer.error.code}/${answer.error.reason}`;
};

beforeAll(async () => {
    if (!enabled) return;
    gitlab = await startFakeGitlab();
    fakeHost = new URL(gitlab.base).host;
});

// The harness empties the tables between tests, so each test seeds its own orgs, members and app.
beforeEach(async () => {
    if (!enabled) return;
    sql = db.sql;
    secrets = testSecretStore(sql);
    [orgA, orgB] = [testOrg(), testOrg()];
    for (const id of [orgA, orgB]) await sql`insert into organization (id, name) values (${id}, ${`org-${id}`})`;
    storeA = storeOf(orgA);
    storeB = storeOf(orgB);

    const auth = createAuthStore({ sql });
    const tokenFor = async (org: string) => {
        const login = `u-${randomUUID().slice(0, 8)}`;
        const caller = await auth.signIn(
            { githubUserId: randomGithubId(), login, displayName: login, avatarUrl: null },
            org,
            [{ id: org, name: org }]
        );
        const token = `fat_${randomUUID()}`;
        await auth.createAccessToken({
            kind: 'personal',
            orgId: org,
            userId: caller.user.id,
            createdBy: caller.user.id,
            label: 'gitlab',
            tokenHash: hashToken(token),
        });
        return token;
    };
    // The first sign-in into an org is its admin; the next is a member.
    adminA = await tokenFor(orgA);
    memberA = await tokenFor(orgA);
    adminB = await tokenFor(orgB);
    const config = testConfig({ auth: githubAuth() });
    const ready = Promise.resolve();
    app = await buildApp({
        config,
        orgs: createOrgRegistry({
            sql,
            ready,
            config,
            withStores: true,
            secrets,
            secretLog: () => {},
            gitlabApi: gitlabApi(),
        }),
        auth,
        ready,
        version: '0.0.0',
    });
});

afterEach(async () => {
    if (enabled) await app?.close();
});
afterAll(async () => {
    await gitlab?.stop();
});

describe.skipIf(!enabled)('forge connection store', () => {
    it('persists a pending connection and keeps the secret and the CA bundle only in the secret store', async () => {
        const made = await storeA.create(input({ caBundle: CA_PEM }));
        if (!made.ok) throw new Error('create refused');
        const { connection } = made;
        expect(connection).toMatchObject({
            forge: 'gitlab',
            host,
            allowedGroups: ['platform'],
            hasCaBundle: true,
            active: false,
            probe: { status: 'reachable', reason: null },
        });
        expect(JSON.stringify(connection)).not.toMatch(/secret|MIIB/);
        const row = await rowOf(connection.id);
        expect(await readSecret(orgA, connection.id, 'client-secret', row!.secret_ref)).toMatch(/^secret-/);
        expect(await readSecret(orgA, connection.id, 'ca-bundle', row!.ca_secret_ref!)).toBe(CA_PEM);
        const dump = JSON.stringify(await sql`select * from forge_connection where id = ${connection.id}`);
        expect(dump).not.toMatch(/secret-[0-9a-f]{8}-|MIIB/);
    });

    it('records no CA reference when no bundle was given', async () => {
        const made = await storeOf(orgA).create(input({ host: named('nobundle') }));
        if (!made.ok) throw new Error('create refused');
        expect(made.connection.hasCaBundle).toBe(false);
        expect((await rowOf(made.connection.id))!.ca_secret_ref).toBeNull();
    });

    it('isolates orgs: the same host connects in both, a second connect in one org is refused, lists never cross', async () => {
        const a = await storeA.create(input({ host: named('iso') }));
        const b = await storeB.create(input({ host: named('iso') }));
        expect(a.ok && b.ok).toBe(true);
        expect(await storeA.create(input({ host: named('iso') }))).toEqual({ ok: false, reason: 'exists' });
        const idA = a.ok ? a.connection.id : '';
        expect((await storeB.list()).map((c) => c.id)).not.toContain(idA);
        expect(await storeB.get(idA)).toBeNull();
        expect(await storeB.remove(idA)).toBe(false);
        expect(await storeA.get(idA)).not.toBeNull();
        const refA = (await rowOf(idA))!.secret_ref as SecretRef;
        // A reference copied to another org's identity reads as a mismatch, never the secret.
        const foreign = await secrets.readActive({
            identity: gitlabConnectionIdentity(orgB, idA, 'client-secret'),
            ref: refA,
        });
        expect(foreign.ok).toBe(false);
    });

    it('stays pending and says why when the instance answers 5xx, malformed, or not at all, and keeps the row', async () => {
        const cases = [
            { fault: { mode: 'status', status: 503 }, reason: 'server-error' },
            { fault: { mode: 'malformed' }, reason: 'malformed' },
            { fault: { mode: 'timeout' }, reason: 'timeout' },
        ];
        for (const [index, { fault, reason }] of cases.entries()) {
            await gitlab.control('gitlab/faults', { ...fault, pathIncludes: '/version', count: 1 });
            const made = await storeA.create(input({ host: named(`fault${index}`) }));
            await gitlab.control('gitlab/faults', { mode: 'none' });
            if (!made.ok) throw new Error('create refused');
            expect(made.connection).toMatchObject({ active: false, probe: { status: 'unreachable', reason } });
            expect(await storeA.get(made.connection.id)).not.toBeNull();
        }
    });

    it('stores a pending connection with a reason when the probe throws, synchronously or not', async () => {
        const throwing = (probe: () => never | Promise<never>) =>
            createForgeConnectionStore({
                sql,
                orgId: orgA,
                secrets,
                secretLog: () => {},
                gitlab: { ...gitlabApi(), probe },
            });
        const sync = await throwing(() => {
            throw new Error('setup failed');
        }).create(input({ host: named('syncthrow') }));
        const async_ = await throwing(() => Promise.reject(new Error('probe failed'))).create(
            input({ host: named('asyncthrow') })
        );
        for (const made of [sync, async_]) {
            if (!made.ok) throw new Error('create refused');
            expect(made.connection).toMatchObject({
                active: false,
                probe: { status: 'unreachable', reason: 'unreachable' },
            });
        }
    });

    it('reports an unreachable host as pending with reason unreachable', async () => {
        const made = await storeA.create(input({ host: '127.0.0.1:9' }));
        if (!made.ok) throw new Error('create refused');
        expect(made.connection).toMatchObject({
            active: false,
            probe: { status: 'unreachable', reason: 'unreachable' },
        });
        expect(await storeA.get(made.connection.id)).not.toBeNull();
    });

    it('removes the row and retires both secrets', async () => {
        const made = await storeA.create(input({ host: named('rm'), caBundle: CA_PEM }));
        if (!made.ok) throw new Error('create refused');
        const row = (await rowOf(made.connection.id))!;
        expect(await storeA.remove(made.connection.id)).toBe(true);
        expect(await storeA.remove(made.connection.id)).toBe(false);
        expect(await rowOf(made.connection.id)).toBeUndefined();
        expect(await readSecret(orgA, made.connection.id, 'client-secret', row.secret_ref)).toMatch(/^not-found/);
        expect(await readSecret(orgA, made.connection.id, 'ca-bundle', row.ca_secret_ref!)).toMatch(/^not-found/);
    });

    it('writes nothing when the secret store fails: no row, EnvSecretError for the route to answer 503', async () => {
        const broken = faultySecrets(secrets, {
            create: async () => ({ ok: false, error: { code: 'unavailable', reason: 'provider-unavailable' } }),
        });
        const before = (await sql`select 1 from forge_connection where org_id = ${orgA}`).length;
        await expect(storeOf(orgA, broken).create(input({ host: named('down') }))).rejects.toBeInstanceOf(
            EnvSecretError
        );
        expect((await sql`select 1 from forge_connection where org_id = ${orgA}`).length).toBe(before);
    });

    /** The store with every create recorded, and the faults a test scripts on top. */
    const recording = (overrides: Partial<SecretStore> = {}) => {
        const created: { ref: SecretRef; identity: SecretIdentity }[] = [];
        const store = faultySecrets(secrets, {
            create: (call) => {
                created.push({ ref: call.ref, identity: call.identity });
                return secrets.create(call);
            },
            ...overrides,
        });
        return { store, created };
    };
    const live = async (created: { ref: SecretRef; identity: SecretIdentity }[]) => {
        const refs: string[] = [];
        for (const { ref, identity } of created) {
            if ((await secrets.readActive({ identity, ref })).ok) refs.push(ref);
        }
        return refs;
    };
    const unavailable = async () => ({
        ok: false as const,
        error: { code: 'unavailable' as const, reason: 'provider-unavailable' as const },
    });
    const tombstoned = async (id: string) =>
        (await sql<{ removed_at: Date | null }[]>`select removed_at from forge_connection where id = ${id}`)[0];

    /** The pool with the connection's publish and the immediate cleanup's read failing: a database still down. */
    const databaseDown = () =>
        failingPoolQuery(failingPoolQuery(sql, 'set secret_version'), 'ca_secret_ref from forge_connection');
    const backdate = (host: string) =>
        sql`update forge_connection set removed_at = now() - interval '10 minutes' where host = ${host}`;
    const rowOfHost = async (host: string) =>
        (
            await sql<{ id: string; removed_at: Date | null; secret_version: string | null }[]>`
            select id, removed_at, secret_version from forge_connection where host = ${host}
        `
        )[0];

    it('keeps a tombstone naming the secrets when the publish fails and the cleanup read fails; recovery retires them', async () => {
        const { store, created } = recording();
        const host = named('publishdown');
        const down = createForgeConnectionStore({
            sql: databaseDown(),
            orgId: orgA,
            secrets: store,
            secretLog: () => {},
            gitlab: gitlabApi(),
        });
        await expect(down.create(input({ host, caBundle: CA_PEM }))).rejects.toThrow();
        expect(created).toHaveLength(2);
        expect(await live(created)).toHaveLength(2);
        const row = await rowOfHost(host);
        expect(row).toMatchObject({ secret_version: null });
        expect(row?.removed_at).not.toBeNull();
        expect(await storeA.get(row!.id)).toBeNull();
        // The creating process may still publish: the sweep leaves a young unpublished row alone.
        expect(await sweepRemovedConnections({ sql, secrets, secretLog: () => {} })).toBe(0);
        expect(await live(created)).toHaveLength(2);
        // After a restart past the grace period, recovery retires both and drops the row.
        await backdate(host);
        expect(await sweepRemovedConnections({ sql, secrets, secretLog: () => {} })).toBeGreaterThanOrEqual(1);
        expect(await live(created)).toEqual([]);
        expect(await rowOfHost(host)).toBeUndefined();
    });

    it('keeps a tombstone when the publish fails and the secret delete then fails; recovery retires them', async () => {
        const { store, created } = recording();
        const host = named('deletedown');
        const down = createForgeConnectionStore({
            sql: failingPoolQuery(sql, 'set secret_version'),
            orgId: orgA,
            secrets: faultySecrets(store, { delete: unavailable }),
            secretLog: () => {},
            gitlab: gitlabApi(),
        });
        await expect(down.create(input({ host, caBundle: CA_PEM }))).rejects.toThrow();
        expect(await live(created)).toHaveLength(2);
        expect(await rowOfHost(host)).toBeDefined();
        await backdate(host);
        await sweepRemovedConnections({ sql, secrets, secretLog: () => {} });
        expect(await live(created)).toEqual([]);
        expect(await rowOfHost(host)).toBeUndefined();
    });

    it('retires a secret whose earlier write left an unresolved operation, after a restart', async () => {
        const keys = new MutableKeys();
        const harness = createPostgresHarness(sql, { keys, deadlineMs: 3000 });
        const made = await storeOf(orgA, harness.open()).create(input({ host: named('unresolved') }));
        if (!made.ok) throw new Error('create refused');
        const { id } = made.connection;
        const row = (await rowOf(id))!;
        const identity = gitlabConnectionIdentity(orgA, id, 'client-secret');
        // A write whose commit was sent and never answered: the version is staged, the operation recorded `unknown`.
        const ambiguous = harness.openWith({
            ...harness.realRepo,
            activate: async () => {
                throw dbError('CONNECTION_CLOSED');
            },
        });
        const operationId = await ambiguous.issueOperationId();
        const replaced = await ambiguous.replace({
            identity,
            ref: row.secret_ref as SecretRef,
            operationId,
            expectedVersion: row.secret_version as never,
            payload: new TextEncoder().encode('half-written'),
        });
        expect(replaced).toMatchObject({ ok: false, error: { code: 'outcome-unknown' } });
        const [op] = await sql<
            { state: string }[]
        >`select state from secret_operation where operation_id = ${operationId}`;
        expect(op?.state).toBe('unknown');

        // Delete while the store cannot delete: the removal stays pending.
        const down = faultySecrets(harness.open(), { delete: unavailable });
        await expect(storeOf(orgA, down).remove(id)).rejects.toBeInstanceOf(EnvSecretError);
        // A restart: a new store, a recovery pass. It reconciles the unknown operation before it deletes.
        expect(await sweepRemovedConnections({ sql, secrets: harness.reopen(), secretLog: () => {} })).toBe(1);
        expect(await rowOf(id)).toBeUndefined();
        const [left] = await sql<{ n: number }[]>`
            select count(*)::int as n from secret_operation
            where ref = ${row.secret_ref} and state in ('pending', 'unknown')
        `;
        expect(left?.n).toBe(0);
        expect((await secrets.readActive({ identity, ref: row.secret_ref as SecretRef })).ok).toBe(false);
    });

    it('leaves no secret behind when only one of the two is created', async () => {
        const { store, created } = recording({
            create: async (call) => {
                if (call.identity.owningRecord.id.endsWith('/ca-bundle')) return unavailable();
                created.push({ ref: call.ref, identity: call.identity });
                return secrets.create(call);
            },
        });
        const created_: typeof created = created;
        await expect(
            storeOf(orgA, store).create(input({ host: named('onesecret'), caBundle: CA_PEM }))
        ).rejects.toBeInstanceOf(EnvSecretError);
        expect(created_.map((c) => c.identity.owningRecord.id.split('/')[1])).toEqual(['client-secret']);
        expect(await live(created_)).toEqual([]);
        expect((await sql`select 1 from forge_connection where host = ${named('onesecret')}`).length).toBe(0);
    });

    it('keeps exactly one connection and its secrets when two creates for one org and host race', async () => {
        const { store, created } = recording();
        const host = named('race');
        const results = await Promise.all([
            storeOf(orgA, store).create(input({ host, caBundle: CA_PEM })),
            storeOf(orgA, store).create(input({ host, caBundle: CA_PEM })),
        ]);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'exists' }]);
        const winner = results.find((r) => r.ok);
        const id = winner?.ok ? winner.connection.id : '';
        const survivors = await live(created);
        expect(survivors).toHaveLength(2);
        const row = (await rowOf(id))!;
        expect(survivors.sort()).toEqual([row.secret_ref, row.ca_secret_ref].sort());
    });

    it('keeps a tombstone and answers an error when the secret store is down during delete; the sweep then retires', async () => {
        const made = await storeA.create(input({ host: named('rmdown'), caBundle: CA_PEM }));
        if (!made.ok) throw new Error('create refused');
        const { id } = made.connection;
        const row = (await rowOf(id))!;
        const down = faultySecrets(secrets, { delete: unavailable });
        await expect(storeOf(orgA, down).remove(id)).rejects.toBeInstanceOf(EnvSecretError);
        expect((await tombstoned(id))?.removed_at).not.toBeNull();
        expect(await storeA.get(id)).toBeNull();
        expect(await readSecret(orgA, id, 'client-secret', row.secret_ref)).toMatch(/^secret-/);
        // The store is still down for this sweep: nothing is confirmed, nothing is dropped.
        expect(await sweepRemovedConnections({ sql, secrets: down, secretLog: () => {} })).toBe(0);
        expect(await tombstoned(id)).toBeDefined();
        // Another process, the store back: the sweep finishes the removal.
        expect(await sweepRemovedConnections({ sql, secrets, secretLog: () => {} })).toBeGreaterThanOrEqual(1);
        expect(await tombstoned(id)).toBeUndefined();
        expect(await readSecret(orgA, id, 'client-secret', row.secret_ref)).toMatch(/^not-found/);
        expect(await readSecret(orgA, id, 'ca-bundle', row.ca_secret_ref!)).toMatch(/^not-found/);
    });

    it('finishes a removal the process stopped after the tombstone, whatever step it stopped at', async () => {
        const made = await storeA.create(input({ host: named('rmcrash'), caBundle: CA_PEM }));
        if (!made.ok) throw new Error('create refused');
        const { id } = made.connection;
        const row = (await rowOf(id))!;
        // The process dies inside the first secret delete: the tombstone is written, nothing was retired.
        const dying = faultySecrets(secrets, {
            delete: () => {
                throw new Error('process stopped');
            },
        });
        await expect(storeOf(orgA, dying).remove(id)).rejects.toBeInstanceOf(EnvSecretError);
        expect(await readSecret(orgA, id, 'ca-bundle', row.ca_secret_ref!)).toMatch(/^ca-bundle|^-----BEGIN/);
        // A fresh store, as after a restart, retires from the tombstone alone, with no further admin action.
        await sweepRemovedConnections({ sql, secrets, secretLog: () => {} });
        expect(await tombstoned(id)).toBeUndefined();
        expect(await readSecret(orgA, id, 'client-secret', row.secret_ref)).toMatch(/^not-found/);
        expect(await readSecret(orgA, id, 'ca-bundle', row.ca_secret_ref!)).toMatch(/^not-found/);
    });

    it('lets the host be connected again while its removal awaits retirement', async () => {
        const host = named('reconnect');
        const first = await storeA.create(input({ host }));
        if (!first.ok) throw new Error('create refused');
        await expect(
            storeOf(orgA, faultySecrets(secrets, { delete: unavailable })).remove(first.connection.id)
        ).rejects.toBeInstanceOf(EnvSecretError);
        expect((await storeA.create(input({ host }))).ok).toBe(true);
    });
});

describe.skipIf(!enabled)('GitLab connection routes', () => {
    const call = async (token: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) => {
        const response = await app.inject({
            method,
            url,
            headers: { authorization: `Bearer ${token}` },
            ...(payload === undefined ? {} : { payload: payload as object }),
        });
        return { status: response.statusCode, json: response.json() as ApiBody };
    };

    it('lets an admin connect, read and delete; the answer is the stored pending state without any secret', async () => {
        const body = input({ host: named('route'), caBundle: CA_PEM });
        const created = await call(adminA, 'POST', PATH, body);
        expect(created.status).toBe(CREATED);
        expect(created.json).toMatchObject({ host: named('route'), active: false, hasCaBundle: true });
        expect(JSON.stringify(created.json)).not.toContain(body.clientSecret as string);
        const read = await call(adminA, 'GET', `${PATH}/${created.json.id}`);
        expect(read.status).toBe(OK);
        expect(read.json.id).toBe(created.json.id);
        const list = await call(adminA, 'GET', PATH);
        expect(list.json.connections.map((c) => c.id)).toContain(created.json.id);
        expect((await call(adminA, 'DELETE', `${PATH}/${created.json.id}`)).status).toBe(OK);
        expect((await call(adminA, 'GET', `${PATH}/${created.json.id}`)).status).toBe(NOT_FOUND);
    });

    it('finishes a removal left pending by an unavailable secret store when the admin deletes again', async () => {
        const created = await call(adminA, 'POST', PATH, input({ host: named('route503') }));
        const down = faultySecrets(secrets, {
            delete: async () => ({ ok: false, error: { code: 'unavailable', reason: 'provider-unavailable' } }),
        });
        const flaky = createForgeConnectionStore({
            sql,
            orgId: orgA,
            secrets: down,
            secretLog: () => {},
            gitlab: gitlabApi(),
        });
        await expect(flaky.remove(created.json.id)).rejects.toBeInstanceOf(EnvSecretError);
        // The admin's retry, the store back, completes it and answers success.
        expect((await call(adminA, 'DELETE', `${PATH}/${created.json.id}`)).status).toBe(OK);
        expect((await sql`select 1 from forge_connection where id = ${created.json.id}`).length).toBe(0);
    });

    it('refuses a member on every method and answers 404 for another org’s id', async () => {
        const created = await call(adminA, 'POST', PATH, input({ host: named('guard') }));
        expect((await call(memberA, 'GET', PATH)).status).toBe(FORBIDDEN);
        expect((await call(memberA, 'POST', PATH, input())).status).toBe(FORBIDDEN);
        expect((await call(memberA, 'DELETE', `${PATH}/${created.json.id}`)).status).toBe(FORBIDDEN);
        expect((await call(adminB, 'GET', `${PATH}/${created.json.id}`)).status).toBe(NOT_FOUND);
        expect((await call(adminB, 'DELETE', `${PATH}/${created.json.id}`)).status).toBe(NOT_FOUND);
    });

    it('answers 400 for a malformed body, 409 for a second connection to the host, 404 for a non-uuid id', async () => {
        for (const bad of [
            input({ host: 'not a host' }),
            input({ host: 'https://example.test' }),
            input({ clientId: '' }),
            input({ clientSecret: '' }),
            input({ allowedGroups: [] }),
            input({ allowedGroups: ['a b'] }),
            input({ caBundle: 'not a pem' }),
            input({ host: 'example.test:0' }),
            input({ host: 'example.test:65536' }),
            input({ host: 'example.test:' }),
        ]) {
            expect((await call(adminA, 'POST', PATH, bad)).status).toBe(BAD_REQUEST);
        }
        const body = input({ host: named('dup') });
        expect((await call(adminA, 'POST', PATH, body)).status).toBe(CREATED);
        const again = await call(adminA, 'POST', PATH, body);
        expect(again.status).toBe(CONFLICT);
        expect(again.json.code).toBe('GITLAB_CONNECTION_EXISTS');
        expect((await call(adminA, 'GET', `${PATH}/nope`)).status).toBe(NOT_FOUND);
    });

    it('still answers 201 pending with the reason when the instance is down', async () => {
        const created = await call(adminA, 'POST', PATH, input({ host: '127.0.0.1:9' }));
        expect(created.status).toBe(CREATED);
        expect(created.json).toMatchObject({ active: false, probe: { status: 'unreachable', reason: 'unreachable' } });
    });
});
