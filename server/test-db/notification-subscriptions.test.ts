import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
    createNotificationSubscriptionStore,
    type NotificationSubscriptionStore,
    type SubscriptionFields,
} from '../src/notifications/subscription-store.js';
import { useTestDb } from './harness.js';
import { testOrg } from './fixtures.js';

/**
 * BEL-131: an org's notification subscriptions — org-bound CRUD and `matching`, the read the outbox
 * (BEL-129) fans an event out through. Every store is bound to one org at construction.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const OTHER_ORG = testOrg();
const db = useTestDb({ orgs: [ORG, OTHER_ORG] });

let sql: Sql;
let store: NotificationSubscriptionStore;
let other: NotificationSubscriptionStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createNotificationSubscriptionStore({ sql, orgId: ORG });
    other = createNotificationSubscriptionStore({ sql, orgId: OTHER_ORG });
});

const fields = (over: Partial<SubscriptionFields> = {}): SubscriptionFields => ({
    connectorKind: 'fake',
    connectorConfig: { target: `room-${randomUUID()}` },
    eventKinds: ['task.ready', 'task.blocked', 'task.question'],
    repos: [],
    workflows: [],
    enabled: true,
    ...over,
});

const ready = { kind: 'task.ready', repo: 'acme/api', workflow: 'build' } as const;

const matchedIds = async (s: NotificationSubscriptionStore, event: Parameters<typeof s.matching>[0]) =>
    (await s.matching(event)).map((t) => t.id);

describe('notification subscription store', () => {
    it('create, list, update and remove round-trip in the store’s org', async () => {
        const created = await store.create(fields({ repos: ['acme/api'], workflows: ['build'] }));
        expect(created).toMatchObject({ connectorKind: 'fake', repos: ['acme/api'], workflows: ['build'] });
        expect((await store.list()).find((s) => s.id === created.id)).toEqual(created);

        const replaced = await store.update(created.id, fields({ enabled: false, eventKinds: ['task.blocked'] }));
        expect(replaced).toMatchObject({ id: created.id, enabled: false, eventKinds: ['task.blocked'], repos: [] });
        expect(replaced?.createdAt).toBe(created.createdAt);
        expect(Date.parse(replaced!.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));

        expect(await store.update(randomUUID(), fields())).toBeNull();
        expect(await store.remove(created.id)).toBe(true);
        expect(await store.remove(created.id)).toBe(false);
        expect((await store.list()).some((s) => s.id === created.id)).toBe(false);
    });

    it('an org’s store never reads, updates or removes another org’s row', async () => {
        const mine = await store.create(fields());

        expect((await other.list()).some((s) => s.id === mine.id)).toBe(false);
        expect(await other.update(mine.id, fields({ enabled: false }))).toBeNull();
        expect(await other.remove(mine.id)).toBe(false);

        expect((await store.list()).find((s) => s.id === mine.id)).toEqual(mine);
    });

    it('matching: kind', async () => {
        const only = await store.create(fields({ eventKinds: ['task.ready'] }));

        expect(await matchedIds(store, { ...ready, kind: 'task.ready' })).toContain(only.id);
        expect(await matchedIds(store, { ...ready, kind: 'task.blocked' })).not.toContain(only.id);
    });

    it('matching: disabled never matches', async () => {
        const off = await store.create(fields({ enabled: false }));

        expect(await matchedIds(store, ready)).not.toContain(off.id);
    });

    it('matching: repo filter', async () => {
        const filtered = await store.create(fields({ repos: ['acme/api'] }));
        const unfiltered = await store.create(fields());

        const hit = await matchedIds(store, { ...ready, repo: 'acme/api' });
        const miss = await matchedIds(store, { ...ready, repo: 'acme/web' });
        const none = await matchedIds(store, { ...ready, repo: null });

        expect(hit).toContain(filtered.id);
        expect(miss).not.toContain(filtered.id);
        expect(none).not.toContain(filtered.id);
        for (const ids of [hit, miss, none]) expect(ids).toContain(unfiltered.id);
    });

    it('matching: workflow filter', async () => {
        const filtered = await store.create(fields({ workflows: ['build'] }));
        const unfiltered = await store.create(fields());

        const hit = await matchedIds(store, { ...ready, workflow: 'build' });
        const miss = await matchedIds(store, { ...ready, workflow: 'review' });
        const none = await matchedIds(store, { ...ready, workflow: null });

        expect(hit).toContain(filtered.id);
        expect(miss).not.toContain(filtered.id);
        expect(none).not.toContain(filtered.id);
        for (const ids of [hit, miss, none]) expect(ids).toContain(unfiltered.id);
    });

    it('matching: another org’s subscription never matches', async () => {
        const theirs = await other.create(fields());
        const mine = await store.create(fields());

        const ids = await matchedIds(store, ready);

        expect(ids).toContain(mine.id);
        expect(ids).not.toContain(theirs.id);
    });

    it('matching returns the deliver target', async () => {
        const config = { target: 'room-x', nested: { a: [1, 2] } };
        const sub = await store.create(fields({ connectorKind: 'chat', connectorConfig: config }));

        const targets = await store.matching(ready);

        expect(targets.find((t) => t.id === sub.id)).toEqual({ id: sub.id, kind: 'chat', config });
    });

    it('the table refuses an empty or unknown event kind list', async () => {
        for (const kinds of [[], ['task.exploded']]) {
            await expect(
                sql`insert into notification_subscription (org_id, connector_kind, connector_config, event_kinds, enabled)
                    values (${ORG}, 'fake', ${sql.json({ target: 'x' })}, ${kinds}::text[], true)`
            ).rejects.toMatchObject({ code: '23514' });
        }
    });
});
