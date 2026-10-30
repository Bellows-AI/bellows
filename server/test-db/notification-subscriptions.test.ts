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
 * BEL-131: an org's notification subscriptions — org-bound CRUD (the outbox of BEL-129 fans an event out to them
 * in SQL, see notification-outbox.test.ts). Every store is bound to one org at construction.
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

    it('the table refuses an empty or unknown event kind list', async () => {
        for (const kinds of [[], ['task.exploded']]) {
            await expect(
                sql`insert into notification_subscription (org_id, connector_kind, connector_config, event_kinds, enabled)
                    values (${ORG}, 'fake', ${sql.json({ target: 'x' })}, ${kinds}::text[], true)`
            ).rejects.toMatchObject({ code: '23514' });
        }
    });
});
