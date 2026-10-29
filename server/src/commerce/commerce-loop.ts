import type { AppConfig } from '../config.js';
import type { CommerceStore, UsageKey } from '../db/commerce-store.js';
import type { ServerMetrics } from '../metrics.js';
import type { OrgRegistry } from '../orgs.js';
import { type CommerceClient, createCommerceClient } from './commerce-client.js';

/**
 * Usage delivery (docs/commerce.md): every org's closed claims are queued, leased in batches, POSTed and
 * settled. Safe on every replica — a lease is a token-checked row claim, so two replicas never send the same
 * row together and a replica whose lease lapsed settles nothing. A pass never overlaps the previous one and
 * never throws; the next tick is the retry.
 */

export const COMMERCE_INTERVAL_MS = 60_000;
/** Wall-clock bound for one org's pass, below the interval so a slow service cannot stack passes. */
export const PASS_BUDGET_MS = 45_000;
const BATCH_SIZE = 200;
/** Longer than any one request, so a live POST never loses its lease to another replica. */
const LEASE_MS = 300_000;

export interface UsageReporterDeps {
    orgs: Pick<OrgRegistry, 'list' | 'for'>;
    client: CommerceClient;
    now?: (() => number) | undefined;
    passBudgetMs?: number | undefined;
}

/** Queues, then leases and reports batches until nothing is due or the absolute `deadlineAt` passes. */
async function reportOrg(
    { store, client, now }: { store: CommerceStore; client: CommerceClient; now: () => number },
    orgId: string,
    deadlineAt: number
): Promise<void> {
    await store.enqueueUsage();
    while (now() < deadlineAt) {
        const lease = await store.leaseDueUsage(BATCH_SIZE, LEASE_MS);
        if (!lease) return;
        let acked: UsageKey[] = [];
        let errorCode: string | null = 'report_failed';
        try {
            ({ acked, errorCode } = await client.reportUsage(orgId, lease.records, deadlineAt));
        } catch {
            // Settled below as a failure: a leased batch is never left to wait out its lease.
        }
        await store.settleUsage(lease.token, acked, errorCode ?? undefined);
    }
}

/** One delivery pass over every org; one org's failure is logged, not thrown. */
export function createUsageReporter({
    orgs,
    client,
    now = Date.now,
    passBudgetMs = PASS_BUDGET_MS,
}: UsageReporterDeps): () => Promise<void> {
    return async () => {
        for (const org of await orgs.list()) {
            try {
                const store = (await orgs.for(org.id))?.commerce;
                if (store) await reportOrg({ store, client, now }, org.id, now() + passBudgetMs);
            } catch (e) {
                console.error(`[commerce] usage pass for "${org.id}" failed: ${(e as Error).message}`);
            }
        }
    };
}

/** Runs `pass` now and then on an interval, never overlapping itself. Returns the stop. */
export function startCommerceLoop(pass: () => Promise<void>, intervalMs = COMMERCE_INTERVAL_MS): () => void {
    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            await pass();
        } catch (e) {
            console.error(`[commerce] pass failed: ${(e as Error).message}`);
        } finally {
            running = false;
        }
    };
    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref();
    return () => clearInterval(timer);
}

/** Starts delivery on this replica when COMMERCE_ENABLED, after the migrations; a no-op otherwise. */
export function startCommerceDelivery({
    commerce,
    orgs,
    metrics,
    ready,
}: {
    commerce: AppConfig['commerce'];
    orgs: OrgRegistry;
    metrics: Pick<ServerMetrics, 'timedPass'>;
    ready: Promise<unknown>;
}): void {
    if (!commerce.enabled) return;
    const report = createUsageReporter({
        orgs,
        client: createCommerceClient({ url: commerce.url, token: commerce.token }),
    });
    void ready.then(() => startCommerceLoop(() => metrics.timedPass('commerce_usage', report)));
}
