import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
    createNotificationSubscriptionStore,
    type NotificationSubscriptionStore,
    type SubscriptionFields,
    type SubscriptionView,
} from '../src/notifications/subscription-store.js';
import {
    readSubscriptionCredential,
    subscriptionSecretIdentity,
} from '../src/notifications/subscription-credential.js';
import type { SecretRef, SecretStore } from '../src/secrets/secret-store.js';
import {
    captureDiagnostics,
    failingPoolQuery,
    faultySecrets,
    spySecrets,
    testSecretStore,
} from './env-secrets-harness.js';
import { useTestDb } from './harness.js';
import { testOrg } from './fixtures.js';

/**
 * BEL-131: an org's notification subscriptions — org-bound CRUD (the outbox of BEL-129 fans an event out to them
 * in SQL, see notification-outbox.test.ts). Every store is bound to one org at construction.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const OTHER_ORG = testOrg();
const db = useTestDb({ orgs: [ORG, OTHER_ORG] });

let sql: Sql;
let secrets: SecretStore;
let store: NotificationSubscriptionStore;
let other: NotificationSubscriptionStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    secrets = testSecretStore(sql);
    store = createNotificationSubscriptionStore({ sql, orgId: ORG, secrets, secretLog: () => {} });
    other = createNotificationSubscriptionStore({ sql, orgId: OTHER_ORG, secrets, secretLog: () => {} });
});

const credential = () => `https://discord.example.test/hook/${randomUUID()}`;

const refOf = async (id: string) => {
    const [row] = await sql<{ secret_ref: string; secret_version: string }[]>`
        select secret_ref, secret_version from notification_subscription where org_id = ${ORG} and id = ${id}
    `;
    return row;
};

/** The value the secret store confirms for the subscription's stored reference, or null. */
const readBack = async (id: string, ref: string, version: string, orgId = ORG) =>
    readSubscriptionCredential(
        secrets,
        { identity: subscriptionSecretIdentity(orgId, id), ref, version },
        AbortSignal.timeout(3000)
    );

const rowsFor = async (marker: string) =>
    sql<{ id: string }[]>`select id from notification_subscription where connector_config->>'target' = ${marker}`;

const fields = (over: Partial<SubscriptionFields> = {}): SubscriptionFields => ({
    connectorKind: 'fake',
    connectorConfig: { target: `room-${randomUUID()}` },
    eventKinds: ['task.ready', 'task.blocked', 'task.question'],
    repos: [],
    workflows: [],
    enabled: true,
    ...over,
});

describe('notification subscription store', () => {
    it('create, list, update and remove round-trip in the store’s org', async () => {
        const created = await store.create(fields({ repos: ['acme/api'], workflows: ['build'] }), credential());
        expect(created).toMatchObject({ connectorKind: 'fake', repos: ['acme/api'], workflows: ['build'] });
        expect((await store.list()).find((s) => s.id === created.id)).toEqual(created);

        const replaced = (await store.update(
            created.id,
            fields({ enabled: false, eventKinds: ['task.blocked'] }),
            null
        )) as SubscriptionView;
        expect(replaced).toMatchObject({ id: created.id, enabled: false, eventKinds: ['task.blocked'], repos: [] });
        expect(replaced.createdAt).toBe(created.createdAt);
        expect(Date.parse(replaced.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));

        expect(await store.update(randomUUID(), fields(), null)).toBeNull();
        expect(await store.remove(created.id)).toBe(true);
        expect(await store.remove(created.id)).toBe(false);
        expect((await store.list()).some((s) => s.id === created.id)).toBe(false);
    });

    it('an org’s store never reads, updates or removes another org’s row', async () => {
        const mine = await store.create(fields(), credential());

        expect((await other.list()).some((s) => s.id === mine.id)).toBe(false);
        expect(await other.update(mine.id, fields({ enabled: false }), null)).toBeNull();
        expect(await other.remove(mine.id)).toBe(false);

        expect((await store.list()).find((s) => s.id === mine.id)).toEqual(mine);
    });

    it('create stores ref and version and the secret reads back under the subscription identity', async () => {
        const value = credential();
        const created = await store.create(fields(), value);

        const row = await refOf(created.id);
        expect(row?.secret_ref).toEqual(expect.any(String));
        expect(row?.secret_version).toEqual(expect.any(String));
        expect(await readBack(created.id, row!.secret_ref, row!.secret_version)).toBe(value);
        // The identity is rebuilt from the row's slot: another subscription or org reads nothing.
        expect(await readBack(randomUUID(), row!.secret_ref, row!.secret_version)).toBeNull();
        expect(await readBack(created.id, row!.secret_ref, row!.secret_version, OTHER_ORG)).toBeNull();
        expect(JSON.stringify(created)).not.toContain(value);
        expect(created).not.toHaveProperty('secret_ref');
        expect(JSON.stringify(await store.list())).not.toContain(row!.secret_ref);
    });

    it('create whose insert fails deletes the created secret', async () => {
        const spy = spySecrets(secrets);
        const failing = createNotificationSubscriptionStore({
            sql: failingPoolQuery(sql, 'insert into notification_subscription'),
            orgId: ORG,
            secrets: spy.store,
            secretLog: () => {},
        });
        const marker = `room-${randomUUID()}`;

        await expect(failing.create(fields({ connectorConfig: { target: marker } }), credential())).rejects.toThrow();

        expect(spy.calls.creates).toHaveLength(1);
        expect(spy.calls.deletes.map((d) => d.ref)).toEqual([spy.calls.creates[0]!.ref]);
        expect(await rowsFor(marker)).toEqual([]);
    });

    it('create whose secret write fails persists no row', async () => {
        const marker = `room-${randomUUID()}`;
        const broken = createNotificationSubscriptionStore({
            sql,
            orgId: ORG,
            secrets: faultySecrets(secrets, {
                create: async () => ({ ok: false, error: { code: 'unavailable', reason: 'provider-unavailable' } }),
            }),
            secretLog: () => {},
        });

        await expect(broken.create(fields({ connectorConfig: { target: marker } }), credential())).rejects.toThrow();

        expect(await rowsFor(marker)).toEqual([]);
    });

    it('replace with credential rotates: new secret active, old retired after commit', async () => {
        const spy = spySecrets(secrets);
        const rotating = createNotificationSubscriptionStore({
            sql,
            orgId: ORG,
            secrets: spy.store,
            secretLog: () => {},
        });
        const first = credential();
        const created = await rotating.create(fields(), first);
        const before = (await refOf(created.id))!;

        const second = credential();
        const replaced = await rotating.update(created.id, fields({ enabled: false }), second);

        expect(replaced).toMatchObject({ id: created.id, enabled: false });
        const after = (await refOf(created.id))!;
        expect(after.secret_ref).not.toBe(before.secret_ref);
        expect(await readBack(created.id, after.secret_ref, after.secret_version)).toBe(second);
        expect(await readBack(created.id, before.secret_ref, before.secret_version)).toBeNull();
        expect(spy.calls.deletes.map((d) => d.ref)).toEqual([before.secret_ref]);
    });

    it('replace without credential keeps the ref and version', async () => {
        const value = credential();
        const created = await store.create(fields(), value);
        const before = (await refOf(created.id))!;

        const replaced = await store.update(created.id, fields({ eventKinds: ['task.blocked'] }), null);

        expect(replaced).toMatchObject({ eventKinds: ['task.blocked'] });
        expect(await refOf(created.id)).toEqual(before);
        expect(await readBack(created.id, before.secret_ref, before.secret_version)).toBe(value);
    });

    it('replace without credential across a kind change returns kind-changed and writes nothing', async () => {
        const created = await store.create(fields(), credential());
        const before = (await refOf(created.id))!;

        const result = await store.update(created.id, fields({ connectorKind: 'other', enabled: false }), null);

        expect(result).toBe('kind-changed');
        expect((await store.list()).find((s) => s.id === created.id)).toEqual(created);
        expect(await refOf(created.id)).toEqual(before);
    });

    it('replace with a credential for a missing row releases the secret it created', async () => {
        const spy = spySecrets(secrets);
        const probing = createNotificationSubscriptionStore({
            sql,
            orgId: ORG,
            secrets: spy.store,
            secretLog: () => {},
        });

        expect(await probing.update(randomUUID(), fields(), credential())).toBeNull();

        expect(spy.calls.creates).toHaveLength(1);
        expect(spy.calls.deletes.map((d) => d.ref)).toEqual([spy.calls.creates[0]!.ref]);
    });

    it('remove retires the secret', async () => {
        const spy = spySecrets(secrets);
        const removing = createNotificationSubscriptionStore({
            sql,
            orgId: ORG,
            secrets: spy.store,
            secretLog: () => {},
        });
        const created = await removing.create(fields(), credential());
        const row = (await refOf(created.id))!;

        expect(await removing.remove(created.id)).toBe(true);

        expect(spy.calls.deletes.map((d) => d.ref)).toEqual([row.secret_ref]);
        expect(await readBack(created.id, row.secret_ref, row.secret_version)).toBeNull();
        const gone = spySecrets(secrets);
        const none = createNotificationSubscriptionStore({ sql, orgId: ORG, secrets: gone.store, secretLog: () => {} });
        expect(await none.remove(created.id)).toBe(false);
        expect(gone.calls.deletes).toEqual([]);
    });

    it('an inconclusive referencedInScope read deletes nothing and reports cleanup-failed', async () => {
        const spy = spySecrets(secrets);
        const diagnostics = captureDiagnostics();
        const failing = createNotificationSubscriptionStore({
            sql: failingPoolQuery(
                failingPoolQuery(sql, 'insert into notification_subscription'),
                'select secret_ref from notification_subscription'
            ),
            orgId: ORG,
            secrets: spy.store,
            secretLog: diagnostics.log,
        });

        await expect(failing.create(fields(), credential())).rejects.toThrow();

        expect(spy.calls.creates).toHaveLength(1);
        expect(spy.calls.deletes).toEqual([]);
        expect(diagnostics.events).toEqual([
            expect.objectContaining({ event: 'cleanup-failed', ref: spy.calls.creates[0]!.ref as SecretRef }),
        ]);
    });

    it('the table refuses a row with no credential reference', async () => {
        await expect(
            sql`insert into notification_subscription (org_id, connector_kind, connector_config, event_kinds, enabled)
                values (${ORG}, 'fake', ${sql.json({ target: 'x' })}, ${['task.ready']}::text[], true)`
        ).rejects.toMatchObject({ code: '23502' });
    });

    it('the table refuses an empty or unknown event kind list', async () => {
        for (const kinds of [[], ['task.exploded']]) {
            await expect(
                sql`insert into notification_subscription
                        (org_id, connector_kind, connector_config, event_kinds, enabled, secret_ref, secret_version)
                    values (${ORG}, 'fake', ${sql.json({ target: 'x' })}, ${kinds}::text[], true, 'ref', 'v1')`
            ).rejects.toMatchObject({ code: '23514' });
        }
    });
});
