import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommerceClient, UsageResult } from '../src/commerce/commerce-client.js';
import { createUsageReporter, startCommerceLoop } from '../src/commerce/commerce-loop.js';
import type { CommerceStore, UsageKey, UsageLease, UsageRecord } from '../src/db/commerce-store.js';
import type { OrgRegistry, OrgRuntime } from '../src/orgs.js';

/** BEL-146: usage delivery is non-overlapping, bounded by one absolute pass deadline, and settles every lease it takes. */
const record = (n: number): UsageRecord => ({
    jobId: `00000000-0000-4000-8000-00000000000${n}`,
    rootJobId: `00000000-0000-4000-8000-00000000000${n}`,
    claimSeq: 1,
    requestingJobId: null,
    launch: 'observed',
    adoptsClaimSeq: null,
    startedAt: '2026-08-01T00:00:00.000Z',
    endedAt: '2026-08-01T00:07:00.000Z',
    durationMs: 420_000,
});
const keyOf = (r: UsageRecord): UsageKey => ({ jobId: r.jobId, claimSeq: r.claimSeq });

interface FakeStore extends CommerceStore {
    enqueued: number;
    settled: { token: string; acked: UsageKey[]; errorCode: string | undefined }[];
    batches: UsageRecord[][];
}

/** A store that hands out each prepared batch once, then reports nothing due. */
function fakeStore(batches: UsageRecord[][], options: { settleThrows?: boolean } = {}): FakeStore {
    const queue = [...batches];
    const store: FakeStore = {
        enqueued: 0,
        settled: [],
        batches,
        async enqueueUsage() {
            store.enqueued += 1;
        },
        async leaseDueUsage(): Promise<UsageLease | null> {
            const records = queue.shift();
            return records ? { token: `token-${queue.length}`, records } : null;
        },
        async settleUsage(token, acked, errorCode) {
            if (options.settleThrows) throw new Error('database down');
            store.settled.push({ token, acked: [...acked], errorCode });
        },
        async read() {
            return { plan: null, unreportedClaims: 0 };
        },
    };
    return store;
}

const registry = (orgs: Record<string, CommerceStore | null>): Pick<OrgRegistry, 'list' | 'for'> => ({
    list: async () => Object.keys(orgs).map((id) => ({ id, name: id, installationId: null })),
    for: async (id) => (orgs[id] ? ({ orgId: id, commerce: orgs[id] } as unknown as OrgRuntime) : null),
});

const ackAll = (): CommerceClient => ({
    reportUsage: async (_org, records) => ({ acked: records.map(keyOf), errorCode: null }),
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('usage reporter', () => {
    it('enqueues, reports and settles each batch as acknowledged', async () => {
        const store = fakeStore([[record(1), record(2)], [record(3)]]);
        await createUsageReporter({ orgs: registry({ a: store }), client: ackAll() })();
        expect(store.enqueued).toBe(1);
        expect(store.settled.map((s) => s.acked.length)).toEqual([2, 1]);
    });

    it('a failed report settles the lease as a failure, acknowledging nothing', async () => {
        const store = fakeStore([[record(1)]]);
        const client: CommerceClient = {
            reportUsage: async (): Promise<UsageResult> => ({ acked: [], errorCode: 'status_500' }),
        };
        await createUsageReporter({ orgs: registry({ a: store }), client })();
        expect(store.settled).toEqual([{ token: 'token-0', acked: [], errorCode: 'status_500' }]);
    });

    it('a client that throws is settled as a failure, never left leased', async () => {
        const store = fakeStore([[record(1)]]);
        const client: CommerceClient = {
            reportUsage: async () => {
                throw new Error('unexpected');
            },
        };
        await createUsageReporter({ orgs: registry({ a: store }), client })();
        expect(store.settled).toEqual([{ token: 'token-0', acked: [], errorCode: 'report_failed' }]);
    });

    it('a settle that throws leaves the lease to lapse and does not throw out of the pass', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const store = fakeStore([[record(1)], [record(2)]], { settleThrows: true });
        await expect(
            createUsageReporter({ orgs: registry({ a: store }), client: ackAll() })()
        ).resolves.toBeUndefined();
        expect(store.settled).toEqual([]);
    });

    it('stops leasing once the pass deadline passes', async () => {
        let clock = 1_000;
        const store = fakeStore([[record(1)], [record(2)], [record(3)]]);
        const client: CommerceClient = {
            reportUsage: async (_org, records) => {
                clock += 600; // each call burns more than the budget's remainder
                return { acked: records.map(keyOf), errorCode: null };
            },
        };
        await createUsageReporter({
            orgs: registry({ a: store }),
            client,
            now: () => clock,
            passBudgetMs: 1_000,
        })();
        expect(store.settled).toHaveLength(2);
    });

    it("one org's failure does not stop the next org", async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const broken: CommerceStore = {
            ...fakeStore([]),
            enqueueUsage: async () => {
                throw new Error('database down');
            },
        };
        const healthy = fakeStore([[record(1)]]);
        await createUsageReporter({ orgs: registry({ first: broken, second: healthy }), client: ackAll() })();
        expect(healthy.settled).toHaveLength(1);
    });

    it('skips an org with no commerce store', async () => {
        const healthy = fakeStore([[record(1)]]);
        await createUsageReporter({ orgs: registry({ none: null, second: healthy }), client: ackAll() })();
        expect(healthy.settled).toHaveLength(1);
    });
});

describe('commerce loop', () => {
    it('never overlaps a pass', async () => {
        vi.useFakeTimers();
        let running = 0;
        let peak = 0;
        let release: () => void = () => {};
        const pass = vi.fn(async () => {
            running += 1;
            peak = Math.max(peak, running);
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            running -= 1;
        });
        const stop = startCommerceLoop(pass, 10);
        await vi.advanceTimersByTimeAsync(55);
        expect(peak).toBe(1);
        expect(pass).toHaveBeenCalledTimes(1);
        release();
        await vi.advanceTimersByTimeAsync(15);
        expect(pass.mock.calls.length).toBeGreaterThan(1);
        stop();
    });

    it('a throwing pass does not stop the loop', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const pass = vi.fn(async () => {
            throw new Error('boom');
        });
        const stop = startCommerceLoop(pass, 10);
        await vi.advanceTimersByTimeAsync(35);
        expect(pass.mock.calls.length).toBeGreaterThanOrEqual(3);
        stop();
    });
});
