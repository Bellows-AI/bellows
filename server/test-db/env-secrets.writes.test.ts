import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createEnvVarStore, type EnvVarEntry, type EnvVarStore } from '../src/db/env-var-store.js';
import { EnvSecretError, envSecretIdentity, type EnvSecretScope } from '../src/db/env-secrets.js';
import { MAX_SECRET_BYTES } from '../src/secrets/secret-input.js';
import { ProviderFault } from '../src/secrets/secret-payloads.js';
import type { SecretDiagnostic, SecretStore } from '../src/secrets/secret-store.js';
import { useTestDb } from './harness.js';
import { testOrg, testUser } from './fixtures.js';
import {
    captureDiagnostics,
    failingPoolQuery,
    faultySecrets,
    seedEncryptedRow,
    spySecrets,
    testSecretStore,
} from './env-secrets-harness.js';
import { createPostgresHarness, databaseSnapshot, MutableKeys, wrappedPayloads } from './secrets-postgres-harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

const ORG = testOrg();
const ALICE_USER = testUser('alice');
const ALICE = ALICE_USER.id;
const SCOPES: { label: string; scope: EnvSecretScope }[] = [
    { label: 'org', scope: { kind: 'org' } },
    { label: 'workspace', scope: { kind: 'workspace', userId: ALICE } },
    { label: 'repo', scope: { kind: 'repo', owner: 'Bellows-AI', name: 'bellows.ai' } },
];
const ORG_SCOPE: EnvSecretScope = { kind: 'org' };
const REPO_SCOPE: EnvSecretScope = { kind: 'repo', owner: 'Bellows-AI', name: 'other.ai' };

const db = useTestDb({ orgs: [ORG], users: [ALICE_USER] });

let sql: Sql;
let keys: MutableKeys;
let healthy: ReturnType<typeof testSecretStore>;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    keys = new MutableKeys();
    healthy = testSecretStore(sql, keys);
});

const put = (store: EnvVarStore, scope: EnvSecretScope, vars: readonly EnvVarEntry[]) => {
    if (scope.kind === 'org') return store.replaceOrg(vars);
    if (scope.kind === 'workspace') return store.replaceWorkspace(scope.userId, vars);
    return store.replaceRepo(scope.owner, scope.name, vars);
};

interface StoredRow {
    name: string;
    value: string | null;
    is_secret: boolean;
    secret_ref: string | null;
    secret_version: string | null;
}
const storedRows = async (): Promise<Record<string, StoredRow>> => {
    const rows = await sql<StoredRow[]>`
        select name, value, is_secret, secret_ref, secret_version from env_var where org_id = ${ORG}
    `;
    return Object.fromEntries(rows.map((r) => [r.name, r]));
};

/** What a healthy store says about the reference: `ok`, or the error code. */
const readState = async (scope: EnvSecretScope, name: string, ref: string | null): Promise<string> => {
    const read = await healthy.readActive({
        identity: envSecretIdentity(ORG, scope, name),
        ref: ref as never,
    });
    return read.ok ? 'ok' : read.error.code;
};

const everythingStored = async (): Promise<string> => {
    const snapshot = await databaseSnapshot(sql);
    const rows = await sql`select to_jsonb(e) as row from env_var e`;
    return JSON.stringify({ snapshot, rows }, (_k, v: unknown) => {
        const bytes = v as { type?: string; data?: number[] } | null;
        return bytes?.type === 'Buffer' && bytes.data ? Buffer.from(bytes.data).toString('hex') : v;
    });
};

const secretOf = (name: string) => `${name}-${randomUUID()}`;

const storeOver = (
    secrets: SecretStore,
    secretLog: (d: SecretDiagnostic) => void = () => {},
    options: { writeDeadlineMs?: number; cleanupDeadlineMs?: number } = {}
) => createEnvVarStore({ sql, orgId: ORG, secrets, secretLog, ...options });

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error('expected a rejection');
};

describe.skipIf(!enabled)('env secret writes go through the secret store', () => {
    it.each(SCOPES)('a secret PUT in the $label scope leaves no plaintext in env_var or secret*', async ({ scope }) => {
        const plaintext = secretOf('plain');
        await put(storeOver(healthy), scope, [{ name: 'S', value: plaintext, isSecret: true }]);

        const row = (await storedRows()).S;
        expect(row).toMatchObject({ value: null, is_secret: true });
        expect(row?.secret_ref).toEqual(expect.any(String));
        expect(row?.secret_version).toEqual(expect.any(String));
        const stored = await everythingStored();
        expect(stored).not.toContain(plaintext);
        expect(stored).not.toContain(Buffer.from(plaintext).toString('hex'));
        expect(await readState(scope, 'S', row?.secret_ref ?? null)).toBe('ok');
    });

    it.each(SCOPES)(
        'a non-secret PUT in the $label scope stays plaintext with no secret_ref, and never calls the store',
        async ({ scope }) => {
            const spy = spySecrets(healthy);
            await put(storeOver(spy.store), scope, [{ name: 'P', value: 'visible', isSecret: false }]);

            expect((await storedRows()).P).toMatchObject({
                value: 'visible',
                is_secret: false,
                secret_ref: null,
                secret_version: null,
            });
            expect(spy.calls).toEqual({ creates: [], deletes: [], reconciles: [], replaces: 0 });
        }
    );

    it('a mixed PUT sends only the secret to the store', async () => {
        const spy = spySecrets(healthy);
        await storeOver(spy.store).replaceOrg([
            { name: 'S', value: 's-value', isSecret: true },
            { name: 'P', value: 'p-value', isSecret: false },
        ]);

        expect(spy.calls.creates.map((c) => c.name)).toEqual(['S']);
        const rows = await storedRows();
        expect(rows.P).toMatchObject({ value: 'p-value', secret_ref: null, secret_version: null });
        expect(rows.S).toMatchObject({ value: null });
        expect(rows.S?.secret_ref).toEqual(expect.any(String));
        expect(await storeOver(healthy).resolveFor({ userId: null, repo: null })).toEqual({
            S: 's-value',
            P: 'p-value',
        });
    });

    it('null keeps the stored secret', async () => {
        const spy = spySecrets(healthy);
        const store = storeOver(spy.store);
        await store.replaceOrg([{ name: 'S', value: 'kept', isSecret: true }]);
        const before = (await storedRows()).S;

        await store.replaceOrg([{ name: 'S', value: null, isSecret: true }]);

        expect((await storedRows()).S).toEqual(before);
        expect(spy.calls.creates).toHaveLength(1);
        expect(spy.calls.deletes).toEqual([]);
        expect(await store.resolveFor({ userId: null, repo: null })).toEqual({ S: 'kept' });
    });

    it('an omitted secret deletes its row and its stored secret', async () => {
        const store = storeOver(healthy);
        await store.replaceOrg([{ name: 'S', value: 'gone', isSecret: true }]);
        const ref = (await storedRows()).S?.secret_ref ?? null;

        await store.replaceOrg([{ name: 'P', value: 'p', isSecret: false }]);

        expect(Object.keys(await storedRows())).toEqual(['P']);
        expect(await readState(ORG_SCOPE, 'S', ref)).toBe('not-found');
    });

    it('secret to nonsecret writes the plaintext value and deletes the stored secret', async () => {
        const spy = spySecrets(healthy);
        const store = storeOver(spy.store);
        await store.replaceOrg([{ name: 'X', value: 'was-secret', isSecret: true }]);
        const ref = (await storedRows()).X?.secret_ref ?? null;

        await store.replaceOrg([{ name: 'X', value: 'now-plain', isSecret: false }]);

        expect((await storedRows()).X).toMatchObject({
            value: 'now-plain',
            is_secret: false,
            secret_ref: null,
            secret_version: null,
        });
        expect(await readState(ORG_SCOPE, 'X', ref)).toBe('not-found');
        expect(spy.calls.creates).toHaveLength(1);
    });

    it('nonsecret to secret encrypts', async () => {
        const store = storeOver(healthy);
        await store.replaceOrg([{ name: 'X', value: 'was-plain', isSecret: false }]);
        const plaintext = secretOf('now-secret');

        await store.replaceOrg([{ name: 'X', value: plaintext, isSecret: true }]);

        const row = (await storedRows()).X;
        expect(row).toMatchObject({ value: null, is_secret: true });
        expect(row?.secret_ref).toEqual(expect.any(String));
        expect(await everythingStored()).not.toContain(plaintext);
        expect(await store.resolveFor({ userId: null, repo: null })).toEqual({ X: plaintext });
    });

    it('a changed value gets a new ref and the old one is gone', async () => {
        const spy = spySecrets(healthy);
        const store = storeOver(spy.store);
        await store.replaceOrg([{ name: 'S', value: 'one', isSecret: true }]);
        const first = (await storedRows()).S?.secret_ref ?? null;

        await store.replaceOrg([{ name: 'S', value: 'two', isSecret: true }]);

        const second = (await storedRows()).S?.secret_ref ?? null;
        expect(second).not.toBe(first);
        expect(await readState(ORG_SCOPE, 'S', first)).toBe('not-found');
        expect(await readState(ORG_SCOPE, 'S', second)).toBe('ok');
        expect(spy.calls.replaces).toBe(0);
        expect(await store.resolveFor({ userId: null, repo: null })).toEqual({ S: 'two' });
    });

    it('a failed create rolls back the PUT and deletes the creates that succeeded', async () => {
        const spy = spySecrets(healthy);
        let calls = 0;
        let unavailableRef = '';
        const faulty = faultySecrets(spy.store, {
            create: async (input) => {
                calls += 1;
                if (calls !== 2) return spy.store.create(input);
                unavailableRef = input.ref;
                return { ok: false, error: { code: 'unavailable', reason: 'provider-unavailable' } };
            },
        });
        const store = storeOver(faulty);
        await store.replaceOrg([{ name: 'KEEP', value: 'k', isSecret: false }]);

        const error = await rejection(
            store.replaceOrg([
                { name: 'A', value: 'a', isSecret: true },
                { name: 'B', value: 'b', isSecret: true },
                { name: 'C', value: 'c', isSecret: true },
            ])
        );

        expect(error).toMatchObject({ code: 'unavailable', reason: 'provider-unavailable' });
        expect(Object.keys(await storedRows())).toEqual(['KEEP']);
        for (const created of spy.calls.creates) {
            expect(await readState(ORG_SCOPE, created.name, created.ref)).toBe('not-found');
        }
        expect(spy.calls.reconciles.filter((r) => r.ref === unavailableRef)).toHaveLength(1);
    });

    it('a failed row transaction deletes only refs its scope no longer names', async () => {
        await seedEncryptedRow(sql, healthy, { orgId: ORG, scope: ORG_SCOPE, name: 'OLD' }, 'old');
        const oldRef = (await storedRows()).OLD?.secret_ref ?? null;
        const spy = spySecrets(healthy);

        const error = await rejection(
            storeOver(spy.store).replaceOrg([
                { name: 'D', value: 'd1', isSecret: true },
                { name: 'D', value: 'd2', isSecret: true },
            ])
        );

        expect(error).toMatchObject({ code: '23505' });
        expect((await storedRows()).OLD?.secret_ref).toBe(oldRef);
        expect(await readState(ORG_SCOPE, 'OLD', oldRef)).toBe('ok');
        expect(spy.calls.creates).toHaveLength(2);
        for (const created of spy.calls.creates) {
            expect(await readState(ORG_SCOPE, created.name, created.ref)).toBe('not-found');
        }
        expect(spy.calls.deletes.map((d) => d.ref)).not.toContain(oldRef);
    });

    it('a failed transaction whose scope re-read fails deletes nothing and reports every candidate', async () => {
        await seedEncryptedRow(sql, healthy, { orgId: ORG, scope: ORG_SCOPE, name: 'OLD' }, 'old');
        const oldRef = (await storedRows()).OLD?.secret_ref ?? '';
        const spy = spySecrets(healthy);
        const diag = captureDiagnostics();
        const store = createEnvVarStore({
            sql: failingPoolQuery(sql, 'select secret_ref from env_var'),
            orgId: ORG,
            secrets: spy.store,
            secretLog: diag.log,
        });

        await rejection(
            store.replaceOrg([
                { name: 'D', value: 'plain-d1', isSecret: true },
                { name: 'D', value: 'plain-d2', isSecret: true },
            ])
        );

        expect(spy.calls.deletes).toEqual([]);
        const reported = diag.events.filter((e) => e.event === 'cleanup-failed' && e.kind === 'delete');
        const expected = [...spy.calls.creates.map((c) => c.ref), oldRef].sort();
        expect(reported.map((e) => e.ref).sort()).toEqual(expected);
        expect(reported).toHaveLength(3);
        const text = JSON.stringify(diag.events);
        expect(text).not.toContain('plain-d');
        expect(text).not.toContain('"D"');
    });

    it("a scope re-read ignores another scope's rows", async () => {
        await seedEncryptedRow(sql, healthy, { orgId: ORG, scope: REPO_SCOPE, name: 'R' }, 'repo-secret');
        const repoRef = (await storedRows()).R?.secret_ref ?? null;
        const spy = spySecrets(healthy);

        await rejection(
            storeOver(spy.store).replaceWorkspace(ALICE, [
                { name: 'D', value: 'd1', isSecret: true },
                { name: 'D', value: 'd2', isSecret: true },
            ])
        );

        expect(spy.calls.creates).toHaveLength(2);
        for (const created of spy.calls.creates) {
            expect(await readState({ kind: 'workspace', userId: ALICE }, created.name, created.ref)).toBe('not-found');
        }
        expect(await readState(REPO_SCOPE, 'R', repoRef)).toBe('ok');
    });

    it('a retired-ref delete that fails keeps the PUT committed and reports it', async () => {
        await seedEncryptedRow(sql, healthy, { orgId: ORG, scope: ORG_SCOPE, name: 'OLD' }, 'old');
        const oldRef = (await storedRows()).OLD?.secret_ref ?? '';
        const diag = captureDiagnostics();
        const failing = faultySecrets(healthy, {
            delete: async () => ({ ok: false, error: { code: 'unavailable', reason: 'provider-unavailable' } }),
        });

        await storeOver(failing, diag.log).replaceOrg([{ name: 'P', value: 'p', isSecret: false }]);

        expect(Object.keys(await storedRows())).toEqual(['P']);
        expect(diag.events).toEqual([
            {
                event: 'cleanup-failed',
                kind: 'delete',
                ref: oldRef,
                code: 'unavailable',
                reason: 'provider-unavailable',
            },
        ]);
    });

    it('an outcome-unknown create is reconciled once: succeeded then deleted', async () => {
        const spy = spySecrets(healthy);
        const landedButSilent = faultySecrets(spy.store, {
            create: async (input) => {
                await spy.store.create(input);
                return { ok: false, error: { code: 'outcome-unknown', reason: 'provider-timeout' } };
            },
        });

        const error = await rejection(
            storeOver(landedButSilent).replaceOrg([{ name: 'S', value: 'v', isSecret: true }])
        );

        expect(error).toMatchObject({ code: 'outcome-unknown' });
        expect(spy.calls.reconciles).toHaveLength(1);
        const ref = spy.calls.reconciles[0]?.ref ?? '';
        expect(spy.calls.deletes.map((d) => d.ref)).toEqual([ref]);
        expect(await readState(ORG_SCOPE, 'S', ref)).toBe('not-found');
        expect(await storedRows()).toEqual({});
    });

    it('an outcome-unknown create whose reconcile is pending is reported, not deleted', async () => {
        const spy = spySecrets(healthy);
        const diag = captureDiagnostics();
        const store = faultySecrets(spy.store, {
            create: async (input) => {
                await spy.store.create(input);
                return { ok: false, error: { code: 'outcome-unknown', reason: 'provider-timeout' } };
            },
            reconcileOperation: async () => ({ ok: true, status: { state: 'pending' } }),
        });

        await rejection(storeOver(store, diag.log).replaceOrg([{ name: 'S', value: 'v', isSecret: true }]));

        expect(spy.calls.deletes).toEqual([]);
        const ref = spy.calls.creates[0]?.ref;
        expect(diag.events).toEqual([
            { event: 'cleanup-failed', kind: 'create', ref, code: 'outcome-unknown', reason: 'operation-pending' },
        ]);
    });

    it('a create that fails after staging is reconciled once, and nothing is left readable or it is reported', async () => {
        const h = createPostgresHarness(sql, { deadlineMs: 3000, keys });
        const broken = h.openWith(
            h.faultyRepo,
            wrappedPayloads({
                async write() {
                    throw new ProviderFault('misconfigured');
                },
            })
        );
        const spy = spySecrets(broken);
        const states: string[] = [];
        const observing = faultySecrets(spy.store, {
            reconcileOperation: async (input) => {
                const [op] = await sql<{ state: string }[]>`
                    select state from secret_operation where operation_id = ${input.operationId}
                `;
                states.push(op?.state ?? 'missing');
                return spy.store.reconcileOperation(input);
            },
        });
        const diag = captureDiagnostics();

        const error = await rejection(
            storeOver(observing, diag.log).replaceOrg([{ name: 'S', value: 'v', isSecret: true }])
        );

        expect(error).toMatchObject({ code: 'invalid-configuration' });
        expect(states).toEqual(['pending']);
        expect(spy.calls.reconciles).toHaveLength(1);
        const ref = spy.calls.creates[0]?.ref ?? '';
        const reported = diag.events.some((e) => e.event === 'cleanup-failed' && e.kind === 'create' && e.ref === ref);
        expect((await readState(ORG_SCOPE, 'S', ref)) === 'not-found' || reported).toBe(true);
        expect(await storedRows()).toEqual({});
    });

    it('a provably pre-write refusal is not reconciled', async () => {
        const spy = spySecrets(healthy);
        const diag = captureDiagnostics();
        const plaintext = 'x'.repeat(MAX_SECRET_BYTES + 1);

        const error = await rejection(
            storeOver(spy.store, diag.log).replaceOrg([{ name: 'BIG', value: plaintext, isSecret: true }])
        );

        expect(error).toBeInstanceOf(EnvSecretError);
        expect(error).toMatchObject({ code: 'invalid-input', reason: 'payload-too-large' });
        expect((error as Error).message).not.toContain(plaintext);
        expect(spy.calls.reconciles).toEqual([]);
        expect(spy.calls.deletes).toEqual([]);
        const ref = spy.calls.creates[0]?.ref ?? '';
        const operations = await sql`select 1 from secret_operation where ref = ${ref}`;
        expect(operations).toHaveLength(0);
        expect(diag.events).toEqual([]);
        expect(await everythingStored()).not.toContain(plaintext);
    });

    it('a create delayed past the write deadline is abandoned, tracked and reconciled', async () => {
        const h = createPostgresHarness(sql, { deadlineMs: 3000, keys });
        const slow = h.openWith({
            ...h.realRepo,
            stageVersion: async (version, budgetMs) => {
                await sleep(1000);
                return h.realRepo.stageVersion(version, budgetMs);
            },
        });
        const spy = spySecrets(slow);
        const diag = captureDiagnostics();
        const store = storeOver(spy.store, diag.log, { writeDeadlineMs: 200, cleanupDeadlineMs: 300 });

        const started = Date.now();
        const error = await rejection(store.replaceOrg([{ name: 'S', value: 'v', isSecret: true }]));
        const elapsed = Date.now() - started;

        expect(elapsed).toBeLessThan(200 + 300 + 250);
        expect(error).toMatchObject({ code: 'unavailable', reason: 'provider-timeout' });
        const ref = spy.calls.creates[0]?.ref ?? '';
        const reported = () => diag.events.some((e) => e.event === 'cleanup-failed' && e.ref === ref);
        expect(spy.calls.reconciles.filter((r) => r.ref === ref).length === 1 || reported()).toBe(true);

        await sleep(1500);
        expect((await readState(ORG_SCOPE, 'S', ref)) === 'not-found' || reported()).toBe(true);
        expect(await storedRows()).toEqual({});
    });
});
