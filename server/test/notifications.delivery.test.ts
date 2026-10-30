import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotificationEventRow, SendResult } from '@factory-ai/core';
import { createConnectorRegistry } from '../src/notifications/connector.js';
import { createNotificationDeliverer, startNotificationDelivery } from '../src/notifications/delivery-loop.js';
import type { NotificationOutboxStore, OutboxItem, OutboxKey } from '../src/notifications/outbox-store.js';
import type { ServerMetrics } from '../src/metrics.js';
import type { OrgRegistry, OrgRuntime } from '../src/orgs.js';
import { fakeConnector } from './notifications-fake-connector.js';

/** BEL-129: the deliverer takes one lease at a time, settles each send and releases the lease on every exit. */
const PUBLIC_URL = 'https://board.example.test';

const eventRow = (n: number): NotificationEventRow => ({
    id: `00000000-0000-4000-8000-00000000000${n}`,
    kind: 'task.ready',
    orgId: 'a',
    jobId: `00000000-0000-4000-8000-0000000001${n}`,
    rootJobId: `00000000-0000-4000-8000-0000000001${n}`,
    repo: null,
    workflow: null,
    command: `task ${n}`,
    reason: null,
    prUrl: null,
    questionId: null,
    questions: null,
    occurredAt: '2026-08-01T00:00:00.000Z',
});

const item = (n: number): OutboxItem => ({
    eventId: eventRow(n).id,
    subscriptionId: `00000000-0000-4000-8000-0000000002${n}`,
    target: { kind: 'fake', config: { target: `room-${n}` }, credential: { ref: `ref-${n}`, version: `v-${n}` } },
    event: eventRow(n),
});

interface FakeStore extends NotificationOutboxStore {
    settled: { token: string; key: OutboxKey; result: SendResult }[];
    released: string[];
    credentialReads: OutboxItem[];
}

/** A store that hands out each prepared lease once, then reports nothing due. */
function fakeStore(
    leases: OutboxItem[][],
    options: {
        settleThrows?: boolean;
        credentialOf?: (item: OutboxItem, signal: AbortSignal) => Promise<string | null>;
    } = {}
): FakeStore {
    const queue = [...leases];
    const store: FakeStore = {
        settled: [],
        released: [],
        credentialReads: [],
        async lease() {
            const items = queue.shift();
            return items ? { token: `token-${queue.length}`, items } : null;
        },
        async settle(token, key, result) {
            if (options.settleThrows) throw new Error('database down');
            store.settled.push({ token, key, result });
        },
        async release(token) {
            store.released.push(token);
        },
        async credentialOf(it, signal) {
            store.credentialReads.push(it);
            return options.credentialOf ? options.credentialOf(it, signal) : `cred-for-${it.target.credential.ref}`;
        },
    };
    return store;
}

const registry = (orgs: Record<string, NotificationOutboxStore | null>): Pick<OrgRegistry, 'list' | 'for'> => ({
    list: async () => Object.keys(orgs).map((id) => ({ id, name: id, installationId: null })),
    for: async (id) => (orgs[id] ? ({ orgId: id, notificationOutbox: orgs[id] } as unknown as OrgRuntime) : null),
});

const deliverer = (
    orgs: Pick<OrgRegistry, 'list' | 'for'>,
    fake: ReturnType<typeof fakeConnector> = fakeConnector('fake'),
    sendTimeoutMs?: number
) =>
    createNotificationDeliverer({
        orgs,
        connectors: createConnectorRegistry([fake]),
        publicUrl: PUBLIC_URL,
        ...(sendTimeoutMs === undefined ? {} : { sendTimeoutMs }),
    });

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('notification deliverer', () => {
    it('release is called exactly once per lease on a normal exit', async () => {
        const store = fakeStore([[item(1), item(2)], [item(3)]]);

        await deliverer(registry({ a: store }))();

        expect(store.settled.map((s) => s.result.status)).toEqual(['delivered', 'delivered', 'delivered']);
        expect(store.released).toEqual(['token-1', 'token-0']);
    });

    it('a settle that throws still releases the lease exactly once and the next org runs', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const broken = fakeStore([[item(1)]], { settleThrows: true });
        const healthy = fakeStore([[item(2)]]);

        await deliverer(registry({ a: broken, b: healthy }))();

        expect(broken.released).toEqual(['token-0']);
        expect(healthy.settled).toHaveLength(1);
        expect(healthy.released).toEqual(['token-0']);
    });

    it('the credential the store read reaches send, beside the config', async () => {
        const store = fakeStore([[item(1)]]);
        const fake = fakeConnector('fake');

        await deliverer(registry({ a: store }), fake)();

        expect(fake.sent.map((s) => ({ config: s.config, credential: s.credential }))).toEqual([
            { config: { target: 'room-1' }, credential: 'cred-for-ref-1' },
        ]);
    });

    it('a null credential settles retryable credential-unavailable, never calls deliver, releases the lease once', async () => {
        const store = fakeStore([[item(1), item(2)]], {
            credentialOf: async (it) => (it.eventId === item(1).eventId ? null : 'ok'),
        });
        const fake = fakeConnector('fake');

        await deliverer(registry({ a: store }), fake)();

        expect(store.settled.map((s) => s.result)).toEqual([
            { status: 'retryable', reason: 'credential-unavailable' },
            { status: 'delivered', externalId: `fake-${eventRow(2).id}` },
        ]);
        expect(fake.sent).toHaveLength(1);
        expect(store.released).toEqual(['token-0']);
    });

    it('a credential read that throws is unconfirmed: retryable, never parked, lease released once', async () => {
        const store = fakeStore([[item(1)]], {
            credentialOf: async () => {
                throw new Error('secret store down');
            },
        });
        const fake = fakeConnector('fake');

        await deliverer(registry({ a: store }), fake)();

        expect(fake.sent).toEqual([]);
        expect(store.settled.map((s) => s.result)).toEqual([{ status: 'retryable', reason: 'credential-unavailable' }]);
        expect(store.released).toEqual(['token-0']);
    });

    it('the credential read and the send share one per-send signal: a hanging read is cut at sendTimeoutMs', async () => {
        const seen: AbortSignal[] = [];
        const store = fakeStore([[item(1)]], {
            credentialOf: (_it, signal) =>
                new Promise<string | null>((resolve) => {
                    seen.push(signal);
                    signal.addEventListener('abort', () => resolve(null), { once: true });
                }),
        });
        const fake = fakeConnector('fake', async (_e, _c, signal) => {
            seen.push(signal);
            return { status: 'delivered' };
        });

        const started = Date.now();
        await deliverer(registry({ a: store }), fake, 50)();

        expect(Date.now() - started).toBeLessThan(2000);
        expect(seen).toHaveLength(1);
        expect(seen[0]!.aborted).toBe(true);
        expect(store.settled.map((s) => s.result)).toEqual([{ status: 'retryable', reason: 'credential-unavailable' }]);
        expect(fake.sent).toEqual([]);
    });

    it('an org without an outbox store is skipped', async () => {
        const healthy = fakeStore([[item(1)]]);

        await deliverer(registry({ none: null, second: healthy }))();

        expect(healthy.settled).toHaveLength(1);
    });
});

describe('startNotificationDelivery', () => {
    const metrics = () => {
        const spy = vi.fn((_name: string, fn: () => Promise<unknown>) => fn());
        return { spy, timedPass: spy as unknown as ServerMetrics['timedPass'] };
    };

    it('starts nothing for an empty registry', async () => {
        vi.useFakeTimers();
        const orgs = { list: vi.fn(async () => []), for: vi.fn() };
        const m = metrics();

        startNotificationDelivery({
            connectors: createConnectorRegistry([]),
            publicUrl: PUBLIC_URL,
            orgs: orgs as unknown as OrgRegistry,
            metrics: m,
            ready: Promise.resolve(),
        });
        await vi.advanceTimersByTimeAsync(120_000);

        expect(orgs.list).not.toHaveBeenCalled();
        expect(m.spy).not.toHaveBeenCalled();
    });

    it('starts nothing without a public URL, and warns', async () => {
        vi.useFakeTimers();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const orgs = { list: vi.fn(async () => []), for: vi.fn() };
        const m = metrics();

        startNotificationDelivery({
            connectors: createConnectorRegistry([fakeConnector('fake')]),
            publicUrl: null,
            orgs: orgs as unknown as OrgRegistry,
            metrics: m,
            ready: Promise.resolve(),
        });
        await vi.advanceTimersByTimeAsync(120_000);

        expect(warn).toHaveBeenCalledWith('[notifications] PUBLIC_URL unset: delivery off');
        expect(orgs.list).not.toHaveBeenCalled();
        expect(m.spy).not.toHaveBeenCalled();
    });

    it('runs a notification_delivery pass once connectors and a public URL exist', async () => {
        vi.useFakeTimers();
        const orgs = { list: vi.fn(async () => []), for: vi.fn() };
        const m = metrics();

        startNotificationDelivery({
            connectors: createConnectorRegistry([fakeConnector('fake')]),
            publicUrl: PUBLIC_URL,
            orgs: orgs as unknown as OrgRegistry,
            metrics: m,
            ready: Promise.resolve(),
        });
        await vi.advanceTimersByTimeAsync(10);

        expect(m.spy).toHaveBeenCalledWith('notification_delivery', expect.any(Function));
        expect(orgs.list).toHaveBeenCalled();
    });
});
