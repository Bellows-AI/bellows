import { notificationEventOf, type SendResult } from '@factory-ai/core';
import { startIntervalLoop } from '../interval-loop.js';
import type { ServerMetrics } from '../metrics.js';
import type { OrgRegistry } from '../orgs.js';
import { type ConnectorRegistry, deliver } from './connector.js';
import type { NotificationOutboxStore } from './outbox-store.js';

/**
 * Notification delivery (docs/notifications.md): every org's due outbox rows are leased in batches, sent
 * through the connector registry and settled one at a time. Safe on every replica — a lease is a token-checked
 * row claim. A pass never overlaps the previous one and never throws; the next tick is the retry.
 */

export const NOTIFICATION_INTERVAL_MS = 10_000;
/** Wall-clock bound for one org's pass, below the lease so a live send never loses its row. */
export const PASS_BUDGET_MS = 30_000;
export const SEND_TIMEOUT_MS = 10_000;
/** Longer than a pass budget plus one send, so a live send never loses its lease to another replica. */
export const LEASE_MS = 300_000;
const BATCH_SIZE = 50;

export interface NotificationDelivererDeps {
    orgs: Pick<OrgRegistry, 'list' | 'for'>;
    connectors: ConnectorRegistry;
    publicUrl: string;
    now?: (() => number) | undefined;
    passBudgetMs?: number | undefined;
    sendTimeoutMs?: number | undefined;
}

interface SendDeps {
    connectors: ConnectorRegistry;
    publicUrl: string;
    now: () => number;
    sendTimeoutMs: number;
}

/** Leases, sends and settles batches until nothing is due or the absolute `deadlineAt` passes. */
async function deliverOrg(
    store: NotificationOutboxStore,
    orgId: string,
    { connectors, publicUrl, now, sendTimeoutMs }: SendDeps,
    deadlineAt: number
): Promise<void> {
    while (now() < deadlineAt) {
        const lease = await store.lease(BATCH_SIZE, LEASE_MS);
        if (!lease) return;
        try {
            for (const item of lease.items) {
                if (now() >= deadlineAt) break;
                const signal = AbortSignal.timeout(Math.max(1, Math.min(sendTimeoutMs, deadlineAt - now())));
                const credential = await store.credentialOf(item, signal).catch(() => null);
                // An unconfirmed read is retryable, never parked: a hiccup in the secret store must not end a delivery.
                const result: SendResult =
                    credential === null
                        ? { status: 'retryable', reason: 'credential-unavailable' }
                        : await deliver(
                              connectors,
                              { ...item.target, credential },
                              notificationEventOf(item.event, publicUrl),
                              signal
                          );
                await store.settle(lease.token, item, result);
                if (result.status === 'permanent') {
                    // Ids and the closed reason only: the config can carry a destination.
                    console.warn(
                        `[notifications] parked ${orgId}/${item.eventId}/${item.subscriptionId}: ${result.reason}`
                    );
                }
            }
        } finally {
            await store.release(lease.token);
        }
    }
}

/** One delivery pass over every org; one org's failure is logged, not thrown. */
export function createNotificationDeliverer({
    orgs,
    connectors,
    publicUrl,
    now = Date.now,
    passBudgetMs = PASS_BUDGET_MS,
    sendTimeoutMs = SEND_TIMEOUT_MS,
}: NotificationDelivererDeps): () => Promise<void> {
    return async () => {
        for (const org of await orgs.list()) {
            try {
                const store = (await orgs.for(org.id))?.notificationOutbox;
                if (store) {
                    await deliverOrg(
                        store,
                        org.id,
                        { connectors, publicUrl, now, sendTimeoutMs },
                        now() + passBudgetMs
                    );
                }
            } catch (e) {
                console.error(`[notifications] delivery pass for "${org.id}" failed: ${(e as Error).message}`);
            }
        }
    };
}

/**
 * Starts delivery on this replica after the migrations. Nothing starts without a registered connector (a
 * subscription cannot exist without one) or without a public URL to build the event link from.
 */
export function startNotificationDelivery({
    connectors,
    publicUrl,
    orgs,
    metrics,
    ready,
}: {
    connectors: ConnectorRegistry;
    publicUrl: string | null;
    orgs: OrgRegistry;
    metrics: Pick<ServerMetrics, 'timedPass'>;
    ready: Promise<unknown>;
}): void {
    if (connectors.size === 0) return;
    if (publicUrl === null) {
        console.warn('[notifications] PUBLIC_URL unset: delivery off');
        return;
    }
    const pass = createNotificationDeliverer({ orgs, connectors, publicUrl });
    void ready.then(() =>
        startIntervalLoop(
            'notifications',
            () => metrics.timedPass('notification_delivery', pass),
            NOTIFICATION_INTERVAL_MS
        )
    );
}
