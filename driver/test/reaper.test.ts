import { describe, expect, it, vi } from 'vitest';
import type { BoardLease, ReclaimHold } from '../src/board.js';
import { LEASE_BATCH_MAX } from '../src/board.js';
import { createReaper, reapDecision, type OrphanGroup, type ReaperArm, type ReapVerdict } from '../src/reaper.js';

/**
 * The reaper's decision core, offline: the board is a stub answering from a map, the arm records
 * what it was told to reap, and the clock is injected — the same harness posture every other
 * driver suite takes (the transport injected the way createBoard takes fetch).
 */

const JOB_A = '11111111-1111-4111-8111-111111111111';
const JOB_B = '44444444-4444-4444-8444-444444444444';
const LEASE_OLD = '22222222-2222-4222-8222-222222222222';
const LEASE_NEW = '33333333-3333-4333-8333-333333333333';

const group = (overrides: Partial<OrphanGroup> = {}): OrphanGroup => ({
    jobId: JOB_A,
    leaseToken: LEASE_OLD,
    createdAtMs: 1_000_000,
    objects: [{ kind: 'container', name: 'svc-postgres' }],
    ...overrides,
});

const lease = (overrides: Partial<BoardLease> = {}): BoardLease => ({
    id: JOB_A,
    status: 'dead',
    leaseToken: null,
    ...overrides,
});

/** The round is far past any grace this suite configures, unless a test says otherwise. */
const NOW = 10_000_000;
const GRACE = 60_000;

describe('reapDecision — the board answer decides, age only defers', () => {
    it.each(['succeeded', 'failed', 'dead', 'stopped'] as const)(
        "reaps a %s job's objects as gone, whatever lease label they carry",
        (status) => {
            expect(reapDecision(lease({ status }), group(), NOW, GRACE)).toBe('gone');
            expect(reapDecision(lease({ status, leaseToken: LEASE_NEW }), group(), NOW, GRACE)).toBe('gone');
        }
    );

    it('reaps the objects of a job the board has never heard of as gone', () => {
        // undefined = absent from the batched answer — the board saying "no such job here".
        expect(reapDecision(undefined, group(), NOW, GRACE)).toBe('gone');
    });

    it('reaps a superseded lease while the job runs under another', () => {
        expect(reapDecision(lease({ status: 'running', leaseToken: LEASE_NEW }), group(), NOW, GRACE)).toBe(
            'superseded'
        );
    });

    it('reaps every labelled object of a queued or unleased running job — nobody holds it', () => {
        expect(reapDecision(lease({ status: 'queued', leaseToken: null }), group(), NOW, GRACE)).toBe('superseded');
        expect(reapDecision(lease({ status: 'running', leaseToken: null }), group(), NOW, GRACE)).toBe('superseded');
    });

    it("never reaps the live lease's own objects — the attempt's teardown and the fence own those", () => {
        expect(reapDecision(lease({ status: 'running', leaseToken: LEASE_OLD }), group(), NOW, GRACE)).toBeNull();
    });

    it('defers a decided reap inside the grace window, and allows it after', () => {
        const young = group({ createdAtMs: NOW - GRACE / 2 });
        expect(reapDecision(lease(), young, NOW, GRACE)).toBeNull();
        // Same board answer, past the window: the deferred action happens.
        expect(reapDecision(lease(), young, NOW + GRACE, GRACE)).toBe('gone');
        // The boundary itself is past grace: an object exactly as old as the window is eligible.
        expect(reapDecision(lease(), group({ createdAtMs: NOW - GRACE }), NOW, GRACE)).toBe('gone');
    });

    it('defers even when the verdict is only the grace away from being wrong — age never decides', () => {
        // A live lease is never reaped at ANY age.
        expect(
            reapDecision(lease({ status: 'running', leaseToken: LEASE_OLD }), group({ createdAtMs: 0 }), NOW, 0)
        ).toBeNull();
    });
});

interface ArmCall {
    group: OrphanGroup;
    verdict: ReapVerdict;
}

const recordingArm = (removed: string[] = ['pod svc-postgres']): { arm: ReaperArm; calls: ArmCall[] } => {
    const calls: ArmCall[] = [];
    return {
        calls,
        arm: {
            async scan() {
                return [];
            },
            async reap(g, verdict) {
                calls.push({ group: g, verdict });
                return removed;
            },
        },
    };
};

const noHolds = async (): Promise<ReclaimHold[] | null> => [];

const boardOf = (
    answer: BoardLease[] | null,
    calls: string[][] = [],
    reclaimHolds: (ids: readonly string[]) => Promise<ReclaimHold[] | null> = noHolds
) => ({
    leases: async (ids: readonly string[]) => {
        calls.push([...ids]);
        return answer === null ? null : answer.filter((row) => ids.includes(row.id));
    },
    reclaimHolds,
});

describe('the reaper sweep', () => {
    it('scans, asks the board once, and reaps what the decision table condemns', async () => {
        const { arm, calls } = recordingArm();
        const terminal = group();
        const live = group({ jobId: JOB_B, leaseToken: LEASE_NEW });
        arm.scan = async () => [terminal, live];
        const leaseCalls: string[][] = [];
        const logs: string[] = [];
        const reaper = createReaper({
            board: boardOf([lease(), lease({ id: JOB_B, status: 'running', leaseToken: LEASE_NEW })], leaseCalls),
            arm,
            intervalMs: 3_600_000,
            graceMs: GRACE,
            now: () => NOW,
            log: (m) => logs.push(m),
        });

        await reaper.sweep();

        expect(leaseCalls).toEqual([[JOB_A, JOB_B]]);
        expect(calls).toEqual([{ group: terminal, verdict: 'gone' }]);
        expect(logs).toEqual([`reaper: job ${JOB_A} lease ${LEASE_OLD} (gone) — removed pod svc-postgres`]);
    });

    it('reaps nothing — not even a scan-condemned group — when the board cannot answer', async () => {
        const { arm, calls } = recordingArm();
        arm.scan = async () => [group()];
        const reaper = createReaper({
            board: boardOf(null),
            arm,
            intervalMs: 3_600_000,
            graceMs: GRACE,
            now: () => NOW,
        });

        await reaper.sweep();

        expect(calls).toEqual([]);
    });

    it('skips groups whose factory.job label is not a uuid — a foreign object must not disable the sweep', async () => {
        const { arm } = recordingArm();
        arm.scan = async () => [group({ jobId: 'not-a-uuid' }), group()];
        const logs: string[] = [];
        const leaseCalls: string[][] = [];
        const reaper = createReaper({
            board: boardOf([], leaseCalls),
            arm,
            intervalMs: 3_600_000,
            graceMs: GRACE,
            now: () => NOW,
            log: (m) => logs.push(m),
        });

        await reaper.sweep();

        // The junk id never reaches the board: asking about it would 400 the whole batch and
        // permanently disable the reaper while the object lives.
        expect(leaseCalls).toEqual([[JOB_A]]);
        expect(logs.some((line) => line.includes('not a uuid'))).toBe(true);
    });

    it('chunks the ids by the batch bound and aborts the round when any chunk is refused', async () => {
        const { arm, calls } = recordingArm();
        const groups: OrphanGroup[] = [];
        for (let i = 0; i < LEASE_BATCH_MAX + 1; i += 1) {
            const id = `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`;
            groups.push(group({ jobId: id }));
        }
        arm.scan = async () => groups;
        const leaseCalls: string[][] = [];
        const board = {
            leases: async (ids: readonly string[]) => {
                leaseCalls.push([...ids]);
                // The first chunk is answered with "none of these are known"; the second is
                // REFUSED — the board cannot answer — which must abort the whole round.
                return leaseCalls.length === 1 ? [] : null;
            },
            reclaimHolds: noHolds,
        };
        const reaper = createReaper({
            board,
            arm,
            intervalMs: 3_600_000,
            graceMs: GRACE,
            now: () => NOW,
        });

        await reaper.sweep();

        expect(leaseCalls).toHaveLength(2);
        expect(leaseCalls[0]).toHaveLength(LEASE_BATCH_MAX);
        expect(leaseCalls[1]!.length).toBeGreaterThan(0);
        // The first chunk was answered, but the second's refusal aborts the WHOLE round —
        // absence must be proven for every id before anything is condemned.
        expect(calls).toEqual([]);
    });

    it("keeps sweeping after an arm failure — a refused delete is the next round's problem", async () => {
        const { arm } = recordingArm();
        arm.scan = async () => [group()];
        arm.reap = async () => {
            throw new Error('delete refused');
        };
        const reaper = createReaper({
            board: boardOf([lease()]),
            arm,
            intervalMs: 3_600_000,
            graceMs: GRACE,
            now: () => NOW,
            log: () => {},
        });
        // The sweep must not throw out of the timer; the failure is logged and the round ends.
        await expect(reaper.sweep()).resolves.toBeUndefined();
    });

    it('does not overlap its own sweeps', async () => {
        let releaseScan: (() => void) | null = null;
        const { arm } = recordingArm();
        arm.scan = () =>
            new Promise((resolve) => {
                releaseScan = () => resolve([group()]);
            });
        let leaseCalls = 0;
        const reaper = createReaper({
            board: {
                leases: async () => {
                    leaseCalls += 1;
                    return [];
                },
                reclaimHolds: noHolds,
            },
            arm,
            intervalMs: 3_600_000,
            graceMs: GRACE,
            now: () => NOW,
        });

        const first = reaper.sweep();
        const second = reaper.sweep();
        releaseScan!();
        await Promise.all([first, second]);

        expect(leaseCalls).toBe(1);
    });
});

/**
 * Issue #829 (G7): a reclaim group is labelled with the acquisition token holding it. Its fate is the
 * board's answer to "is that acquisition still held", not its root job's lease: the root is terminal
 * or removed by the time a reclaim runs, so the lease lookup alone would reap a live reclaim.
 */
describe('the reaper sweep — reclaim groups', () => {
    const HOLDER = '55555555-5555-4555-8555-555555555555';
    const OTHER_HOLDER = '66666666-6666-4666-8666-666666666666';
    const reclaimGroup = (overrides: Partial<OrphanGroup> = {}): OrphanGroup =>
        group({ objects: [{ kind: 'job', name: 'reclaim', holder: HOLDER }], ...overrides });

    const sweepWith = async (opts: {
        groups: OrphanGroup[];
        holds: ((ids: readonly string[]) => Promise<ReclaimHold[] | null>) | ReclaimHold[] | null;
        leases?: BoardLease[] | null;
        holdCalls?: string[][];
    }) => {
        const { arm, calls } = recordingArm();
        arm.scan = async () => opts.groups;
        const reclaimHolds = async (ids: readonly string[]) => {
            opts.holdCalls?.push([...ids]);
            if (typeof opts.holds === 'function') return opts.holds(ids);
            return opts.holds;
        };
        const reaper = createReaper({
            board: boardOf(opts.leases === undefined ? [lease()] : opts.leases, [], reclaimHolds),
            arm,
            intervalMs: 3_600_000,
            graceMs: GRACE,
            now: () => NOW,
            log: () => {},
        });
        await reaper.sweep();
        return calls;
    };

    it('spares a reclaim whose acquisition the board still holds, though its root job is terminal or absent', async () => {
        const held = [{ id: JOB_A, token: HOLDER }];
        expect(await sweepWith({ groups: [reclaimGroup()], holds: held, leases: [lease()] })).toEqual([]);
        expect(await sweepWith({ groups: [reclaimGroup()], holds: held, leases: [] })).toEqual([]);
    });

    it('reaps a reclaim the board does not hold as gone, past the grace window', async () => {
        const g = reclaimGroup();
        expect(await sweepWith({ groups: [g], holds: [], leases: [lease({ status: 'running' })] })).toEqual([
            { group: g, verdict: 'gone' },
        ]);
    });

    it('reaps a reclaim held only under another token — the acquisition it served was replaced', async () => {
        const g = reclaimGroup();
        const calls = await sweepWith({ groups: [g], holds: [{ id: JOB_A, token: OTHER_HOLDER }] });
        expect(calls).toEqual([{ group: g, verdict: 'gone' }]);
    });

    it('defers an unheld reclaim inside the grace window', async () => {
        const young = reclaimGroup({ createdAtMs: NOW - GRACE / 2 });
        expect(await sweepWith({ groups: [young], holds: [] })).toEqual([]);
    });

    it('reaps nothing — not even an unrelated orphan — when the holds lookup is refused', async () => {
        const holdCalls: string[][] = [];
        const orphan = group({ jobId: JOB_B });
        const calls = await sweepWith({
            groups: [reclaimGroup(), orphan],
            holds: null,
            leases: [lease(), lease({ id: JOB_B })],
            holdCalls,
        });
        expect(holdCalls).toEqual([[JOB_A]]);
        expect(calls).toEqual([]);
    });

    it('reaps nothing when the holds lookup throws', async () => {
        const calls = await sweepWith({
            groups: [reclaimGroup()],
            holds: async () => {
                throw new Error('board unreachable');
            },
        });
        expect(calls).toEqual([]);
    });

    it('spares a group whose objects carry mixed or missing holders', async () => {
        const mixed = reclaimGroup({
            objects: [
                { kind: 'job', name: 'a', holder: HOLDER },
                { kind: 'job', name: 'b', holder: OTHER_HOLDER },
            ],
        });
        const partial = reclaimGroup({
            jobId: JOB_B,
            objects: [
                { kind: 'job', name: 'a', holder: HOLDER },
                { kind: 'job', name: 'b' },
            ],
        });
        expect(
            await sweepWith({ groups: [mixed, partial], holds: [], leases: [lease(), lease({ id: JOB_B })] })
        ).toEqual([]);
    });

    it('does not ask the board about holds when no group is a reclaim group', async () => {
        const holdCalls: string[][] = [];
        await sweepWith({ groups: [group()], holds: [], holdCalls });
        expect(holdCalls).toEqual([]);
    });

    it('chunks the holds lookup by the batch bound and aborts the round when any chunk is refused', async () => {
        const groups: OrphanGroup[] = [];
        for (let i = 0; i < LEASE_BATCH_MAX + 1; i += 1) {
            groups.push(reclaimGroup({ jobId: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111` }));
        }
        const holdCalls: string[][] = [];
        const calls = await sweepWith({
            groups,
            leases: [],
            holdCalls,
            holds: async () => (holdCalls.length === 1 ? [] : null),
        });
        expect(holdCalls.map((ids) => ids.length)).toEqual([LEASE_BATCH_MAX, 1]);
        expect(calls).toEqual([]);
    });
});

describe('the reaper timer', () => {
    it('sweeps on the interval until stopped', async () => {
        vi.useFakeTimers();
        try {
            let leaseCalls = 0;
            const { arm } = recordingArm();
            // One real group, so the sweep reaches the board's lease lookup.
            arm.scan = async () => [group()];
            const reaper = createReaper({
                board: {
                    leases: async () => {
                        leaseCalls += 1;
                        return [];
                    },
                    reclaimHolds: noHolds,
                },
                arm,
                intervalMs: 1_000,
                graceMs: 0,
                now: () => NOW,
            });
            reaper.start();
            await vi.advanceTimersByTimeAsync(3_500);
            reaper.stop();
            await vi.advanceTimersByTimeAsync(10_000);
            // The immediate first sweep plus one per interval tick, and nothing after stop.
            expect(leaseCalls).toBe(4);
        } finally {
            vi.useRealTimers();
        }
    });

    it('never starts when the interval is zero — the off switch', async () => {
        vi.useFakeTimers();
        try {
            let leaseCalls = 0;
            const { arm } = recordingArm();
            arm.scan = async () => [group()];
            const reaper = createReaper({
                board: {
                    leases: async () => {
                        leaseCalls += 1;
                        return [];
                    },
                    reclaimHolds: noHolds,
                },
                arm,
                intervalMs: 0,
                graceMs: 0,
                now: () => NOW,
            });
            reaper.start();
            await vi.advanceTimersByTimeAsync(30_000);
            expect(leaseCalls).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
});
