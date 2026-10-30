import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { RETRY_CAP_MS } from '../src/db/outbox-backoff.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import { createConnectorRegistry } from '../src/notifications/connector.js';
import { createNotificationDeliverer, LEASE_MS } from '../src/notifications/delivery-loop.js';
import { createNotificationOutboxStore, type NotificationOutboxStore } from '../src/notifications/outbox-store.js';
import {
    createNotificationSubscriptionStore,
    type NotificationSubscriptionStore,
    type SubscriptionFields,
} from '../src/notifications/subscription-store.js';
import type { OrgRegistry, OrgRuntime } from '../src/orgs.js';
import { fakeConnector, type FakeScript } from '../test/notifications-fake-connector.js';
import { useTestDb } from './harness.js';
import { testOrg } from './fixtures.js';

/**
 * BEL-129: the durable notification outbox. The settle's own transaction fans an event out to the
 * subscriptions that match it at that moment (104); a replica-safe deliverer leases the rows, sends through the
 * connector registry and settles each one on the store's injected clock.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const OTHER = testOrg();
const WORKER = 'worker-1';
const PUBLIC_URL = 'https://board.example.test';
const T0 = Date.now();
const db = useTestDb({ max: 4, orgs: [ORG, OTHER] });

let sql: Sql;
let jobs: JobStore;
let otherJobs: JobStore;
let subs: NotificationSubscriptionStore;
let otherSubs: NotificationSubscriptionStore;
const clock = { t: T0 };

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    jobs = createJobStore({ sql, orgId: ORG });
    otherJobs = createJobStore({ sql, orgId: OTHER });
    subs = createNotificationSubscriptionStore({ sql, orgId: ORG });
    otherSubs = createNotificationSubscriptionStore({ sql, orgId: OTHER });
});

beforeEach(() => {
    clock.t = T0;
});

afterEach(() => {
    vi.restoreAllMocks();
});

const outboxFor = (org = ORG): NotificationOutboxStore =>
    createNotificationOutboxStore({ sql, orgId: org, now: () => new Date(clock.t) });

const orgsOf = (stores: Record<string, NotificationOutboxStore>): Pick<OrgRegistry, 'list' | 'for'> => ({
    list: async () => Object.keys(stores).map((id) => ({ id, name: id, installationId: null })),
    for: async (id) => ({ orgId: id, notificationOutbox: stores[id] }) as unknown as OrgRuntime,
});

interface PassOptions {
    outbox?: NotificationOutboxStore;
    passBudgetMs?: number;
    sendTimeoutMs?: number;
}

/** One delivery pass for ORG on the shared test clock. */
const pass = (fake: ReturnType<typeof fakeConnector>, o: PassOptions = {}) =>
    createNotificationDeliverer({
        orgs: orgsOf({ [ORG]: o.outbox ?? outboxFor() }),
        connectors: createConnectorRegistry([fake]),
        publicUrl: PUBLIC_URL,
        now: () => clock.t,
        ...(o.passBudgetMs === undefined ? {} : { passBudgetMs: o.passBudgetMs }),
        ...(o.sendTimeoutMs === undefined ? {} : { sendTimeoutMs: o.sendTimeoutMs }),
    })();

const fields = (over: Partial<SubscriptionFields> = {}): SubscriptionFields => ({
    connectorKind: 'fake',
    connectorConfig: { target: `room-${randomUUID()}` },
    eventKinds: ['task.ready', 'task.blocked', 'task.question'],
    repos: [],
    workflows: [],
    enabled: true,
    ...over,
});

interface Emit {
    store?: JobStore;
    org?: string;
    command?: string;
    repo?: string | null;
    workflow?: string | null;
}

/** Queues, claims and settles one task through the real job store; returns the job id. */
async function emit({
    store = jobs,
    org = ORG,
    command = 'ship the thing',
    repo = null,
    workflow = null,
}: Emit = {}): Promise<string> {
    const created = await store.create(command, null, { repo, executor: null });
    if (typeof created === 'string') throw new Error(created);
    if (workflow !== null) {
        await sql`update job set workflow_name = ${workflow} where org_id = ${org} and id = ${created.id}`;
    }
    const claim = await store.claim(WORKER, 300);
    if (claim?.id !== created.id) throw new Error('the task was not the one claimed');
    await store.complete(created.id, claim.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
    return created.id;
}

interface OutboxRow {
    event_id: string;
    subscription_id: string;
    attempts: number;
    next_attempt_at: Date | null;
    claim_token: string | null;
    claimed_until: Date | null;
    delivered_at: Date | null;
    parked_at: Date | null;
    last_error: string | null;
}

const rows = (org = ORG) =>
    sql<OutboxRow[]>`
        select event_id, subscription_id, attempts, next_attempt_at, claim_token, claimed_until, delivered_at,
               parked_at, last_error
        from notification_outbox where org_id = ${org} order by subscription_id, event_id
    `;

const rowOf = async (subscriptionId: string): Promise<OutboxRow> => {
    const found = (await rows()).filter((r) => r.subscription_id === subscriptionId);
    expect(found).toHaveLength(1);
    return found[0]!;
};

const verdict =
    (...results: unknown[]): FakeScript =>
    async () =>
        results.shift() ?? { status: 'delivered' };

describe.skipIf(!enabled)('notification outbox — fan-out at emission', () => {
    it('fans an event out to each matching enabled subscription', async () => {
        const a = await subs.create(fields());
        const b = await subs.create(fields({ eventKinds: ['task.ready'], repos: ['acme/api'] }));
        await emit({ repo: 'acme/api' });

        const found = await rows();

        expect(found.map((r) => r.subscription_id).sort()).toEqual([a.id, b.id].sort());
        for (const row of found) {
            expect(row).toMatchObject({
                attempts: 0,
                next_attempt_at: null,
                claim_token: null,
                claimed_until: null,
                delivered_at: null,
                parked_at: null,
                last_error: null,
            });
        }
    });

    it('does not fan out to a non-matching kind, repo or workflow, or to a null repo/workflow under a filter', async () => {
        const open = await subs.create(fields());
        await subs.create(fields({ eventKinds: ['task.blocked'] }));
        await subs.create(fields({ repos: ['acme/api'] }));
        await subs.create(fields({ workflows: ['build'] }));

        await emit({ repo: null, workflow: null });
        await emit({ repo: 'acme/web', workflow: 'review' });

        const found = await rows();
        expect(found).toHaveLength(2);
        expect(new Set(found.map((r) => r.subscription_id))).toEqual(new Set([open.id]));
    });

    it('fans out on the repo and workflow a filter names', async () => {
        const filtered = await subs.create(fields({ repos: ['acme/api'], workflows: ['build'] }));
        await emit({ repo: 'acme/api', workflow: 'build' });
        expect((await rows()).map((r) => r.subscription_id)).toEqual([filtered.id]);
    });

    it('does not fan out to a disabled subscription', async () => {
        await subs.create(fields({ enabled: false }));
        await emit();
        expect(await rows()).toHaveLength(0);
    });

    it('does not fan out to another org’s subscription', async () => {
        const theirs = await otherSubs.create(fields());
        const mine = await subs.create(fields());
        await emit();
        expect((await rows()).map((r) => r.subscription_id)).toEqual([mine.id]);
        expect(await rows(OTHER)).toHaveLength(0);
        expect(theirs.id).not.toBe(mine.id);
    });

    it('a subscription created after the event receives nothing', async () => {
        await emit();
        await subs.create(fields());
        const fake = fakeConnector('fake');

        await pass(fake);

        expect(await rows()).toHaveLength(0);
        expect(fake.sent).toHaveLength(0);
    });

    it('a duplicate event id fans out once', async () => {
        const sub = await subs.create(fields());
        const gated = createJobStore({
            sql,
            orgId: ORG,
            plan: {
                readFor: async () => ({
                    config: null,
                    services: [],
                    revision: null,
                    error: null,
                    policy: { gates: true },
                }),
            },
        });
        const created = await gated.create('ship it', null, { repo: 'acme/web', executor: null });
        if (typeof created === 'string') throw new Error(created);
        const claim = await gated.claim(WORKER, 300);
        await gated.complete(created.id, claim!.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: 'ok',
            evidence: null,
        });
        const fake = fakeConnector('fake');

        await pass(fake);

        expect((await rows()).map((r) => r.subscription_id)).toEqual([sub.id]);
        expect(fake.sent.map((s) => s.event.kind)).toEqual(['task.blocked']);
    });

    it('deleting a subscription removes its pending rows', async () => {
        const gone = await subs.create(fields());
        const kept = await subs.create(fields());
        await emit();
        expect(await rows()).toHaveLength(2);

        expect(await subs.remove(gone.id)).toBe(true);

        expect((await rows()).map((r) => r.subscription_id)).toEqual([kept.id]);
    });
});

describe.skipIf(!enabled)('notification outbox — delivery', () => {
    it('delivers a settled task’s event through the fake connector to a matching enabled subscription only', async () => {
        const target = `room-${randomUUID()}`;
        const match = await subs.create(fields({ connectorConfig: { target }, eventKinds: ['task.ready'] }));
        await subs.create(fields({ eventKinds: ['task.blocked'] }));
        await subs.create(fields({ enabled: false }));
        const id = await emit({ command: 'ship the thing\nmore detail' });
        const fake = fakeConnector('fake');

        await pass(fake);

        expect(fake.sent).toHaveLength(1);
        expect(fake.sent[0]).toMatchObject({
            config: { target },
            event: {
                kind: 'task.ready',
                orgId: ORG,
                jobId: id,
                title: 'ship the thing',
                link: new URL(`/tasks/${id}`, PUBLIC_URL).toString(),
            },
        });
        const row = await rowOf(match.id);
        expect(row.delivered_at).toEqual(new Date(clock.t));
        expect(row).toMatchObject({ claim_token: null, claimed_until: null, last_error: null });
    });

    it('a delivered row is not sent again', async () => {
        await subs.create(fields());
        await emit();
        const fake = fakeConnector('fake');
        await pass(fake);
        clock.t += LEASE_MS * 2;
        await pass(fake);
        expect(fake.sent).toHaveLength(1);
    });

    it('a trigger-inserted row is due on the store’s clock', async () => {
        await subs.create(fields());
        await emit();
        const epoch = createNotificationOutboxStore({ sql, orgId: ORG, now: () => new Date(0) });

        const lease = await epoch.lease(10, LEASE_MS);

        expect(lease?.items).toHaveLength(1);
    });

    it('two replicas lease disjoint rows', async () => {
        await subs.create(fields());
        for (let i = 0; i < 4; i++) await emit({ command: `task ${i}` });

        const [a, b] = await Promise.all([outboxFor().lease(2, LEASE_MS), outboxFor().lease(2, LEASE_MS)]);

        const ids = [...(a?.items ?? []), ...(b?.items ?? [])].map((i) => `${i.eventId}/${i.subscriptionId}`);
        expect(ids).toHaveLength(4);
        expect(new Set(ids).size).toBe(4);
        expect(a?.token).not.toBe(b?.token);
    });

    it('two concurrent delivery passes post each row once', async () => {
        await subs.create(fields());
        for (let i = 0; i < 4; i++) await emit({ command: `task ${i}` });
        const fake = fakeConnector('fake', async (event) => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            return { status: 'delivered', externalId: event.id };
        });

        await Promise.all([pass(fake, { outbox: outboxFor() }), pass(fake, { outbox: outboxFor() })]);

        expect(fake.sent.map((s) => s.event.id).sort()).toEqual([...new Set(fake.sent.map((s) => s.event.id))].sort());
        expect(fake.sent).toHaveLength(4);
        expect((await rows()).every((r) => r.delivered_at !== null)).toBe(true);
    });

    it('a row leased by a lost replica resumes after its lease lapses', async () => {
        const sub = await subs.create(fields());
        await emit();
        const lost = outboxFor();
        const lease = await lost.lease(10, LEASE_MS);
        expect(lease?.items).toHaveLength(1);
        const fake = fakeConnector('fake');

        clock.t = T0 + 1000;
        await pass(fake);
        expect(fake.sent).toHaveLength(0);

        clock.t = T0 + LEASE_MS + 1;
        await pass(fake);
        expect(fake.sent).toHaveLength(1);
        expect((await rowOf(sub.id)).delivered_at).not.toBeNull();
    });

    it('a lapsed replica’s late settle changes nothing', async () => {
        const sub = await subs.create(fields());
        await emit();
        const lost = outboxFor();
        const lease = await lost.lease(10, LEASE_MS);
        const item = lease!.items[0]!;
        const key = { eventId: item.eventId, subscriptionId: item.subscriptionId };
        clock.t = T0 + LEASE_MS + 1;
        await pass(fakeConnector('fake'));
        const before = await rowOf(sub.id);

        await lost.settle(lease!.token, key, { status: 'retryable', reason: 'transport' });
        await lost.settle(lease!.token, key, { status: 'permanent', reason: 'destination-refused' });
        await lost.release(lease!.token);

        expect(await rowOf(sub.id)).toEqual(before);
        expect(before.delivered_at).not.toBeNull();
    });
});

describe.skipIf(!enabled)('notification outbox — retry and park', () => {
    it('a retryable send backs off and then delivers', async () => {
        const sub = await subs.create(fields());
        await emit();
        const fake = fakeConnector('fake', verdict({ status: 'retryable', reason: 'transport' }));

        await pass(fake);
        expect(await rowOf(sub.id)).toMatchObject({ attempts: 1, last_error: 'transport', delivered_at: null });
        expect((await rowOf(sub.id)).next_attempt_at).toEqual(new Date(T0 + 30_000));

        clock.t = T0 + 29_000;
        await pass(fake);
        expect(fake.sent).toHaveLength(1);

        clock.t = T0 + 30_000;
        await pass(fake);
        expect(fake.sent).toHaveLength(2);
        expect(await rowOf(sub.id)).toMatchObject({ attempts: 1, last_error: null });
        expect((await rowOf(sub.id)).delivered_at).toEqual(new Date(clock.t));
    });

    it('retryAfterMs beyond the backoff is honoured and capped', async () => {
        const sub = await subs.create(fields());
        await emit();
        const fake = fakeConnector(
            'fake',
            verdict(
                { status: 'retryable', reason: 'rate-limited', retryAfterMs: 120_000 },
                { status: 'retryable', reason: 'rate-limited', retryAfterMs: 10 * RETRY_CAP_MS }
            )
        );

        await pass(fake);
        expect((await rowOf(sub.id)).next_attempt_at).toEqual(new Date(T0 + 120_000));

        clock.t = T0 + 120_000;
        await pass(fake);
        expect((await rowOf(sub.id)).next_attempt_at).toEqual(new Date(clock.t + RETRY_CAP_MS));
    });

    it('a timed-out send is retryable, never delivered or parked', async () => {
        const sub = await subs.create(fields());
        await emit();
        const fake = fakeConnector(
            'fake',
            (_event, _config, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', reject))
        );

        await pass(fake, { sendTimeoutMs: 20 });

        expect(await rowOf(sub.id)).toMatchObject({
            attempts: 1,
            last_error: 'aborted',
            delivered_at: null,
            parked_at: null,
        });
    });

    it('a throwing connector retries', async () => {
        const sub = await subs.create(fields());
        await emit();
        const fake = fakeConnector('fake', async () => {
            throw new Error('boom');
        });

        await pass(fake);

        expect(await rowOf(sub.id)).toMatchObject({ attempts: 1, last_error: 'connector-threw', parked_at: null });
    });

    it('a permanent verdict parks the row and logs it without the config', async () => {
        const target = `room-${randomUUID()}`;
        const sub = await subs.create(fields({ connectorConfig: { target } }));
        await emit();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const fake = fakeConnector('fake', verdict({ status: 'permanent', reason: 'destination-refused' }));

        await pass(fake);

        const row = await rowOf(sub.id);
        expect(row).toMatchObject({ attempts: 1, last_error: 'destination-refused', claim_token: null });
        expect(row.parked_at).toEqual(new Date(T0));
        clock.t = T0 + RETRY_CAP_MS;
        await pass(fake);
        expect(fake.sent).toHaveLength(1);
        expect(warn).toHaveBeenCalledTimes(1);
        const line = String(warn.mock.calls[0]![0]);
        for (const part of [ORG, row.event_id, sub.id, 'destination-refused']) expect(line).toContain(part);
        expect(line).not.toContain(target);
    });

    it('a subscription disabled after enqueue is parked, not sent, and not replayed on re-enable', async () => {
        const sub = await subs.create(fields());
        await emit();
        await subs.update(sub.id, fields({ enabled: false }));
        const fake = fakeConnector('fake');

        await pass(fake);

        expect(fake.sent).toHaveLength(0);
        expect(await rowOf(sub.id)).toMatchObject({ last_error: 'subscription-disabled', claim_token: null });
        expect((await rowOf(sub.id)).parked_at).toEqual(new Date(T0));

        await subs.update(sub.id, fields({ enabled: true }));
        clock.t = T0 + RETRY_CAP_MS;
        await pass(fake);
        expect(fake.sent).toHaveLength(0);
    });

    it('a disabled subscription’s rows do not stop other subscriptions’ rows in the same lease', async () => {
        const off = await subs.create(fields());
        const on = await subs.create(fields());
        await emit();
        await subs.update(off.id, fields({ enabled: false }));
        const store = outboxFor();

        const lease = await store.lease(1, LEASE_MS);

        expect(lease).not.toBeNull();
        const second = await store.lease(10, LEASE_MS);
        const sent = [...(lease?.items ?? []), ...(second?.items ?? [])].map((i) => i.subscriptionId);
        expect(sent).toEqual([on.id]);
    });

    it('a subscription’s config edited after enqueue is sent with the new config', async () => {
        const sub = await subs.create(fields());
        await emit();
        const target = `room-${randomUUID()}`;
        await subs.update(sub.id, fields({ connectorConfig: { target } }));
        const fake = fakeConnector('fake');

        await pass(fake);

        expect(fake.sent.map((s) => s.config)).toEqual([{ target }]);
    });
});

describe.skipIf(!enabled)('notification outbox — pass bounds and scope', () => {
    it('a pass past its deadline releases the leased rows it did not send', async () => {
        await subs.create(fields());
        for (let i = 0; i < 3; i++) await emit({ command: `task ${i}` });
        let slow = true;
        const fake = fakeConnector('fake', async (event) => {
            if (slow) clock.t += 31_000;
            slow = false;
            return { status: 'delivered', externalId: event.id };
        });

        await pass(fake, { passBudgetMs: 30_000 });

        expect(fake.sent).toHaveLength(1);
        const found = await rows();
        expect(found.filter((r) => r.delivered_at !== null)).toHaveLength(1);
        const unsent = found.filter((r) => r.delivered_at === null);
        expect(unsent).toHaveLength(2);
        for (const row of unsent) expect(row).toMatchObject({ claim_token: null, claimed_until: null, attempts: 0 });

        await pass(fake);
        expect(fake.sent).toHaveLength(3);
    });

    it('an org’s store never leases another org’s rows', async () => {
        await subs.create(fields());
        await otherSubs.create(fields());
        await emit();
        await emit({ store: otherJobs, org: OTHER });

        const mine = await outboxFor(ORG).lease(10, LEASE_MS);
        const theirs = await outboxFor(OTHER).lease(10, LEASE_MS);

        expect(mine?.items.map((i) => i.event.orgId)).toEqual([ORG]);
        expect(theirs?.items.map((i) => i.event.orgId)).toEqual([OTHER]);
    });

    it('a lease with nothing due answers null', async () => {
        expect(await outboxFor().lease(10, LEASE_MS)).toBeNull();
    });
});
