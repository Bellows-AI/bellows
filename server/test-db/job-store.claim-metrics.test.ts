import { beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createServerMetrics } from '../src/metrics.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import {
    admissionLockKey,
    admissionOccupancy,
    type AdmissionBudgets,
    type ClaimObserver,
} from '../src/db/jobs/job-store-admission.js';
import { useTestDb } from './harness.js';
import { craftJob, testOrg } from './fixtures.js';
import { holder, parkedReader, pool, waitForLockWait } from './lock-order-harness.js';

const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const LEASE_SECONDS = 300;
const MINUTE = 60;
const CLAIMER = 'claim-metrics-claimer';

const OTHER = testOrg();
const db = useTestDb({ max: 6, orgs: [ORG, OTHER] });
let sql: Sql;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
});

interface Seen {
    refusals: string[];
    waits: { kind: string; seconds: number }[];
    lockWaits: number[];
    acquires: number[];
    sweeps: number[];
}

const observer = (): { seen: Seen; metrics: ClaimObserver } => {
    const seen: Seen = { refusals: [], waits: [], lockWaits: [], acquires: [], sweeps: [] };
    return {
        seen,
        metrics: {
            refusal: (scope) => void seen.refusals.push(scope),
            wait: (kind, seconds) => void seen.waits.push({ kind, seconds }),
            lockWait: (s) => void seen.lockWaits.push(s),
            acquire: (s) => void seen.acquires.push(s),
            sweep: (s) => void seen.sweeps.push(s),
        },
    };
};

const storeWith = (metrics: ClaimObserver, extra: { admission?: AdmissionBudgets } = {}) =>
    createJobStore({ sql, orgId: ORG, metrics, ...extra });

/** A queued root that has waited `minutes`: created, and released to the queue, that long ago. */
const waiting = async (minutes: number): Promise<string> => {
    const id = await craftJob({ sql, org: ORG, author: '' }, { author: null, createdMinutesAgo: minutes });
    await sql`update job set lease_expires_at = created_at where id = ${id}`;
    return id;
};

describe.skipIf(!enabled)('claim observations', () => {
    it('measures a new row from its queueing, once, with lock wait inside the acquisition', async () => {
        const { seen, metrics } = observer();
        const id = await waiting(10);
        expect((await storeWith(metrics).claim('w1', LEASE_SECONDS))?.id).toBe(id);
        expect(seen.waits).toHaveLength(1);
        expect(seen.waits[0]!.kind).toBe('new');
        expect(seen.waits[0]!.seconds).toBeGreaterThanOrEqual(10 * MINUTE);
        expect(seen.waits[0]!.seconds).toBeLessThan(11 * MINUTE);
        expect(seen.lockWaits).toHaveLength(1);
        expect(seen.acquires).toHaveLength(1);
        expect(seen.acquires[0]!).toBeGreaterThanOrEqual(seen.lockWaits[0]!);
        expect(seen.sweeps).toHaveLength(1);
    });

    it('measures a takeover from the moment its lease lapsed, not from its creation', async () => {
        const { seen, metrics } = observer();
        const id = await waiting(60);
        await sql`update job set status = 'running', started_at = now(), attempts = 1,
                  lease_expires_at = now() - interval '5 minutes' where id = ${id}`;
        expect((await storeWith(metrics).claim('w1', LEASE_SECONDS))?.id).toBe(id);
        expect(seen.waits).toHaveLength(1);
        expect(seen.waits[0]!.kind).toBe('takeover');
        expect(seen.waits[0]!.seconds).toBeGreaterThanOrEqual(5 * MINUTE);
        expect(seen.waits[0]!.seconds).toBeLessThan(6 * MINUTE);
    });

    it('measures a deferred row from the end of its deferral', async () => {
        const { seen, metrics } = observer();
        const id = await waiting(60);
        await sql`update job set claim_deferred_until = now() - interval '2 minutes' where id = ${id}`;
        expect((await storeWith(metrics).claim('w1', LEASE_SECONDS))?.id).toBe(id);
        expect(seen.waits[0]!.seconds).toBeGreaterThanOrEqual(2 * MINUTE);
        expect(seen.waits[0]!.seconds).toBeLessThan(3 * MINUTE);
    });

    it('counts a refusal per refused candidate and records no wait for them', async () => {
        const { seen, metrics } = observer();
        await waiting(3);
        await waiting(2);
        const holder = await sql.reserve();
        try {
            // The only global slot is held by another claimer: every candidate is refused at the acquisition.
            await holder`select pg_advisory_lock(hashtextextended(${admissionLockKey('global', '', 1)}, 0))`;
            expect(await storeWith(metrics, { admission: { global: 1 } }).claim('w1', LEASE_SECONDS)).toBeNull();
        } finally {
            await holder`select pg_advisory_unlock_all()`;
            holder.release();
        }
        expect(seen.refusals).toEqual(['global', 'global']);
        expect(seen.waits).toEqual([]);
        expect(seen.acquires).toHaveLength(2);
    });

    it('records no wait, acquire or lock wait when the claim throws and rolls back', async () => {
        const { seen, metrics } = observer();
        await waiting(1);
        const store = createJobStore({
            sql,
            orgId: ORG,
            metrics,
            env: {
                resolveFor: async () => {
                    throw new Error('env store down');
                },
            },
        });
        await expect(store.claim('w1', LEASE_SECONDS)).rejects.toThrow('env store down');
        expect(seen.waits).toEqual([]);
        expect(seen.acquires).toEqual([]);
        expect(seen.lockWaits).toEqual([]);
    });
});

describe.skipIf(!enabled)('claim wait includes the row lock wait', () => {
    it('reports queued-to-claimed at acquisition, after a row lock held by another writer for ~2 s', async () => {
        const { seen, metrics } = observer();
        const id = await waiting(0);
        const claimPool = pool(CLAIMER);
        const HELD_MS = 2000;
        try {
            const reader = parkedReader();
            const claiming = createJobStore({
                sql: claimPool,
                orgId: ORG,
                metrics,
                plan: { readFor: reader.readFor },
            }).claim('w1', LEASE_SECONDS);
            await reader.entered;
            const row = await holder(sql, (tx) => tx`select id from job where id = ${id} for update`);
            reader.release();
            await waitForLockWait(sql, CLAIMER, Date.now() + HELD_MS * 5);
            await new Promise((resolve) => setTimeout(resolve, HELD_MS));
            row.release();
            await row.done;
            expect((await claiming)?.id).toBe(id);
        } finally {
            await claimPool.end({ timeout: 5 });
        }
        expect(seen.waits).toHaveLength(1);
        expect(seen.waits[0]!.seconds).toBeGreaterThanOrEqual(HELD_MS / 1000 - 0.2);
        expect(seen.lockWaits[0]!).toBeGreaterThanOrEqual(HELD_MS / 1000 - 0.2);
    });
});

describe.skipIf(!enabled)('a scrape while the pool is exhausted', () => {
    it('returns within its deadline, without occupancy samples, counting the failure', async () => {
        const pool = postgres(process.env.DATABASE_URL!, { max: 1 });
        const held = await pool.reserve();
        try {
            const metrics = createServerMetrics({
                admission: { global: 8 },
                occupancy: (signal) => admissionOccupancy(pool, { signal }),
                readDeadlineMs: 300,
            });
            const started = Date.now();
            const text = await metrics.render();
            expect(Date.now() - started).toBeLessThan(3000);
            expect(text).not.toContain('factory_admission_running{');
            expect(text).toContain('factory_metrics_read_failures_total{source="admission"} 1');
            expect(text).toContain('factory_admission_limit{scope="global"} 8');
        } finally {
            held.release();
            await pool.end({ timeout: 2 });
        }
    });
});

describe.skipIf(!enabled)('admission occupancy', () => {
    const running = (org: string, repo: string | null, extra: Partial<Parameters<typeof craftJob>[1]> = {}) =>
        craftJob({ sql, org, author: '' }, { author: null, repo, status: 'running', lease: 'live', ...extra });

    it('counts running non-review rows globally and reports the busiest org and repo without naming them', async () => {
        const before = await admissionOccupancy(sql);
        const parent = await running(ORG, 'acme/a');
        await running(ORG, 'acme/a');
        await running(ORG, 'acme/b');
        await running(OTHER, null);
        const review = await running(ORG, 'acme/a');
        await sql`
            update job set review_of = ${parent}, review_key = 'k', review_profile = 'p',
                           review_spec = '{}'::jsonb, review_revision = 'r', review_ref = 'ref'
            where id = ${review}
        `;
        const after = await admissionOccupancy(sql);
        expect(after.global - before.global).toBe(4);
        expect(after.orgMax).toBeGreaterThanOrEqual(3);
        expect(after.repoMax).toBeGreaterThanOrEqual(2);
        expect(Object.keys(after).sort()).toEqual(['global', 'orgMax', 'repoMax']);
    });

    it('gives up at the statement timeout instead of holding the pool', async () => {
        const holder = await sql.reserve();
        try {
            await holder`begin`;
            await holder`lock table job in access exclusive mode`;
            await expect(admissionOccupancy(sql, { timeoutMs: 200 })).rejects.toThrow(/statement timeout/);
        } finally {
            await holder`rollback`;
            holder.release();
        }
    });
});
