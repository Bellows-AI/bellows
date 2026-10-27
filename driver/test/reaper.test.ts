import { describe, expect, it, vi } from 'vitest';
import type { BoardLease, BoardThreadFacts } from '../src/board/board.js';
import { LEASE_BATCH_MAX } from '../src/board/board.js';
import {
    createReaper,
    reapDecision,
    volumeDecision,
    type OrphanGroup,
    type ReapInconclusive,
    type ReaperArm,
    type ReapVerdict,
    type VolumeThread,
} from '../src/reaper.js';

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

const boardOf = (answer: BoardLease[] | null, calls: string[][] = []) => ({
    leases: async (ids: readonly string[]) => {
        calls.push([...ids]);
        return answer === null ? null : answer.filter((row) => ids.includes(row.id));
    },
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

const HOUR = 3_600_000;
const POLICY = { ttlMs: 24 * HOUR, boundMs: 7 * 24 * HOUR };
const FINALIZED = 1_000 * HOUR;

const thread = (overrides: Partial<BoardThreadFacts> = {}): BoardThreadFacts => ({
    live: false,
    lastFinalizedAt: new Date(FINALIZED).toISOString(),
    artifactsComplete: true,
    checkpoint: 'complete',
    checkpointFinalizedAt: new Date(FINALIZED).toISOString(),
    lastJobId: ROOT_A,
    lastClaimSeq: 1,
    ...overrides,
});

describe('volumeDecision: a task volume goes only on a whole, idle thread (issue #775)', () => {
    it('keeps the volume while any job of the thread is live', () => {
        expect(volumeDecision(thread({ live: true }), FINALIZED + 100 * 24 * HOUR, POLICY)).toBe('keep');
    });

    it('keeps it while the last attempt has artifacts pending, until the bound', () => {
        const facts = thread({ artifactsComplete: false });
        expect(volumeDecision(facts, FINALIZED + 48 * HOUR, POLICY)).toBe('keep');
        expect(volumeDecision(facts, FINALIZED + 7 * 24 * HOUR - 1, POLICY)).toBe('keep');
        expect(volumeDecision(facts, FINALIZED + 7 * 24 * HOUR, POLICY)).toBe('delete');
    });

    it.each(['truncated', 'none'] as const)('keeps a %s checkpoint until the bound, not the ttl', (checkpoint) => {
        const facts = thread({ checkpoint });
        expect(volumeDecision(facts, FINALIZED + 24 * HOUR, POLICY)).toBe('keep');
        expect(volumeDecision(facts, FINALIZED + 7 * 24 * HOUR - 1, POLICY)).toBe('keep');
        expect(volumeDecision(facts, FINALIZED + 7 * 24 * HOUR, POLICY)).toBe('delete');
    });

    it('keeps a whole thread inside the idle ttl and deletes it at the ttl', () => {
        expect(volumeDecision(thread(), FINALIZED + 24 * HOUR - 1, POLICY)).toBe('keep');
        expect(volumeDecision(thread(), FINALIZED + 24 * HOUR, POLICY)).toBe('delete');
    });

    it('never deletes sooner than the ttl when the bound is configured below it', () => {
        const facts = thread({ checkpoint: 'truncated' });
        expect(volumeDecision(facts, FINALIZED + 2 * HOUR, { ttlMs: 24 * HOUR, boundMs: HOUR })).toBe('keep');
    });

    it.each([
        ['no thread facts', undefined],
        ['an attempt that never finalized', thread({ lastFinalizedAt: null })],
        ['a finalize time that is no date', thread({ lastFinalizedAt: 'soon' })],
        [
            'a finalize time in the future',
            thread({ lastFinalizedAt: new Date(FINALIZED + 200 * 24 * HOUR).toISOString() }),
        ],
    ])('keeps the volume on %s', (_name, facts) => {
        expect(volumeDecision(facts, FINALIZED + 100 * 24 * HOUR, POLICY)).toBe('keep');
    });
});

const ROOT_A = '11111111-1111-4111-8111-111111111111';
const ROOT_B = '44444444-4444-4444-8444-444444444444';

describe('the volume sweep: the board decides each thread, the arm deletes every generation', () => {
    const volumes = (root: string): VolumeThread => ({
        root,
        volumes: [{ name: `factory-task-${root}-1` }, { name: `factory-task-${root}-2`, uid: 'uid-2' }],
    });

    /** `answer` may be a function of the 0-based call, the batch lookup being call 0 and each pre-delete re-read after it. */
    const run = async (opts: {
        listed: VolumeThread[] | null;
        skipped?: string[];
        answer: BoardLease[] | null | ((call: number) => BoardLease[] | null);
        now?: number;
    }): Promise<{ reaped: VolumeThread[]; asked: string[][]; logs: string[] }> => {
        const reaped: VolumeThread[] = [];
        const asked: string[][] = [];
        const logs: string[] = [];
        const arm: ReaperArm = {
            scan: async () => [],
            reap: async () => [],
            scanVolumes: async () =>
                opts.listed === null ? null : { threads: opts.listed, skipped: opts.skipped ?? [] },
            reapVolumes: async (t) => {
                reaped.push(t);
                return t.volumes.map((v) => v.name);
            },
        };
        const reaper = createReaper({
            board: {
                leases: async (ids) => {
                    asked.push([...ids]);
                    return typeof opts.answer === 'function' ? opts.answer(asked.length - 1) : opts.answer;
                },
            },
            arm,
            intervalMs: 0,
            graceMs: 0,
            volumePolicy: POLICY,
            now: () => opts.now ?? FINALIZED + 25 * HOUR,
            log: (m) => logs.push(m),
        });
        await reaper.sweep();
        return { reaped, asked, logs };
    };
    const root = (id: string, facts: BoardThreadFacts | undefined, status: BoardLease['status'] = 'succeeded') =>
        ({ id, status, leaseToken: null, ...(facts ? { thread: facts } : {}) }) as BoardLease;

    it('deletes every generation of a whole idle thread, once, asking the board by root id', async () => {
        const out = await run({ listed: [volumes(ROOT_A)], answer: [root(ROOT_A, thread())] });
        // The batch lookup, then a single-root re-read right before the delete.
        expect(out.asked).toEqual([[ROOT_A], [ROOT_A]]);
        expect(out.reaped).toEqual([volumes(ROOT_A)]);
        expect(out.logs.join('\n')).toContain(`factory-task-${ROOT_A}-1`);
    });

    it('decides each thread on its own facts', async () => {
        const out = await run({
            listed: [volumes(ROOT_A), volumes(ROOT_B)],
            answer: [root(ROOT_A, thread({ live: true })), root(ROOT_B, thread())],
        });
        expect(out.reaped.map((t) => t.root)).toEqual([ROOT_B]);
    });

    it('keeps a thread whose answer carries no thread facts', async () => {
        const out = await run({ listed: [volumes(ROOT_B)], answer: [root(ROOT_B, undefined)] });
        expect(out.reaped).toEqual([]);
    });

    describe('a root the board no longer holds (the thread was removed)', () => {
        const dated = (root: string, createdAtMs: number | null | undefined): VolumeThread => ({
            root,
            volumes: [{ name: `factory-task-${root}-1`, createdAtMs }],
        });
        const NOW = FINALIZED + 25 * HOUR;

        it('deletes the volumes once every one is at least the ttl old', async () => {
            const old = dated(ROOT_A, NOW - 24 * HOUR);
            const out = await run({ listed: [old], answer: [], now: NOW });
            expect(out.reaped).toEqual([old]);
        });

        it('keeps them while one is younger than the ttl', async () => {
            const out = await run({ listed: [dated(ROOT_A, NOW - 24 * HOUR + 1)], answer: [], now: NOW });
            expect(out.reaped).toEqual([]);
        });

        it.each([
            ['null', null],
            ['missing', undefined],
        ])('keeps them when the creation time is %s', async (_n, at) => {
            const out = await run({ listed: [dated(ROOT_A, at)], answer: [], now: NOW });
            expect(out.reaped).toEqual([]);
        });

        it('keeps them when the board could not answer: an unanswered lookup is not an absence', async () => {
            const out = await run({ listed: [dated(ROOT_A, 0)], answer: null, now: NOW });
            expect(out.reaped).toEqual([]);
        });

        it('keeps them when the re-read before the delete cannot be answered', async () => {
            const out = await run({
                listed: [dated(ROOT_A, 0)],
                answer: (call) => (call === 0 ? [] : null),
                now: NOW,
            });
            expect(out.reaped).toEqual([]);
        });
    });

    it('keeps a board-condemned thread while its artifacts are pending, and follows the ttl once they complete', async () => {
        const pending = thread({ artifactsComplete: false });
        // Whole at the ttl, pending until the bound: the same thread, 25h idle.
        expect((await run({ listed: [volumes(ROOT_A)], answer: [root(ROOT_A, pending)] })).reaped).toEqual([]);
        const done = await run({ listed: [volumes(ROOT_A)], answer: [root(ROOT_A, thread())] });
        expect(done.reaped).toEqual([volumes(ROOT_A)]);
    });

    it('deletes nothing when the thread went live between the batch lookup and the delete', async () => {
        const out = await run({
            listed: [volumes(ROOT_A)],
            answer: (call) => [root(ROOT_A, call === 0 ? thread() : thread({ live: true }), 'running')],
        });
        expect(out.reaped).toEqual([]);
    });

    it('deletes nothing when the re-read before the delete cannot be answered', async () => {
        const out = await run({
            listed: [volumes(ROOT_A)],
            answer: (call) => (call === 0 ? [root(ROOT_A, thread())] : null),
        });
        expect(out.reaped).toEqual([]);
        // The sweep goes on: the log says this thread is kept, not that the whole round reaps nothing.
        expect(out.logs.join('\n')).toContain(`keeping thread ${ROOT_A} this round`);
        expect(out.logs.join('\n')).not.toContain('reaping nothing');
    });

    it('logs the labelled volumes the arm skipped, and still sweeps the rest', async () => {
        const out = await run({
            listed: [volumes(ROOT_A)],
            skipped: ['task volume junk: root label is not a uuid'],
            answer: [root(ROOT_A, thread())],
        });
        expect(out.logs.join('\n')).toContain('task volume junk');
        expect(out.reaped).toEqual([volumes(ROOT_A)]);
    });

    it('deletes nothing when the volume list is inconclusive, and never asks the board', async () => {
        const out = await run({ listed: null, answer: [root(ROOT_A, thread())] });
        expect(out.reaped).toEqual([]);
        expect(out.asked).toEqual([]);
    });

    it('deletes nothing when the board cannot answer', async () => {
        const out = await run({ listed: [volumes(ROOT_A)], answer: null });
        expect(out.reaped).toEqual([]);
    });

    it('skips a root that is no uuid, without asking the board about it', async () => {
        const out = await run({ listed: [volumes('not-a-uuid')], answer: [] });
        expect(out.asked).toEqual([]);
        expect(out.reaped).toEqual([]);
    });

    it('does not sweep volumes without a policy', async () => {
        const reaped: VolumeThread[] = [];
        const reaper = createReaper({
            board: { leases: async () => [root(ROOT_A, thread())] },
            arm: {
                scan: async () => [],
                reap: async () => [],
                scanVolumes: async () => ({ threads: [volumes(ROOT_A)], skipped: [] }),
                reapVolumes: async (t) => {
                    reaped.push(t);
                    return [];
                },
            },
            intervalMs: 0,
            graceMs: 0,
            now: () => FINALIZED + 100 * 24 * HOUR,
            log: () => undefined,
        });
        await reaper.sweep();
        expect(reaped).toEqual([]);
    });
});

describe('the volume sweep re-exports a thread that is not whole before deleting it (issue #938)', () => {
    const NOT_WHOLE = { artifactsComplete: false };
    const volumesOf = (root: string): VolumeThread => ({ root, volumes: [{ name: `factory-task-${root}-1` }] });
    const rowOf = (id: string, facts: BoardThreadFacts | undefined) =>
        ({ id, status: 'succeeded', leaseToken: null, ...(facts ? { thread: facts } : {}) }) as BoardLease;
    type Exported = Awaited<ReturnType<NonNullable<ReaperArm['exportVolume']>>>;

    /** `answer(root, call)` is the board's answer for that root's `call`-th lookup (0 = the sweep's batch). */
    const harness = (opts: {
        listed: VolumeThread[];
        answer: (root: string, call: number) => BoardLease | undefined;
        exported?: (root: string, signal: AbortSignal) => Promise<Exported>;
        attempts?: number;
        withExportArm?: boolean;
        /** What the arm's delete answers, instead of removing the volumes. */
        reapAnswer?: () => ReapInconclusive;
    }) => {
        const events: string[] = [];
        const logs: string[] = [];
        const outcomes: string[] = [];
        const exports: { root: string; attempt: { jobId: string; claimSeq: number }; signal: AbortSignal }[] = [];
        const lost: string[] = [];
        const reaped = new Set<string>();
        const calls = new Map<string, number>();
        const arm: ReaperArm = {
            scan: async () => [],
            reap: async () => [],
            scanVolumes: async () => ({ threads: opts.listed.filter((t) => !reaped.has(t.root)), skipped: [] }),
            reapVolumes: async (t) => {
                events.push(`reap ${t.root}`);
                if (opts.reapAnswer) return opts.reapAnswer();
                reaped.add(t.root);
                return t.volumes.map((v) => v.name);
            },
            ...(opts.withExportArm === false
                ? {}
                : {
                      exportVolume: async (t, attempt, signal) => {
                          events.push(`export ${t.root}`);
                          exports.push({ root: t.root, attempt, signal });
                          return (opts.exported ?? (async () => ({ result: 'drained' as const })))(t.root, signal);
                      },
                  }),
        };
        const reaper = createReaper({
            board: {
                leases: async (ids) => {
                    const rows: BoardLease[] = [];
                    for (const id of ids) {
                        const call = calls.get(id) ?? 0;
                        calls.set(id, call + 1);
                        const row = opts.answer(id, call);
                        if (row) rows.push(row);
                    }
                    return rows;
                },
            },
            arm,
            intervalMs: 3_600_000,
            graceMs: 0,
            volumePolicy: POLICY,
            ...(opts.attempts === undefined ? {} : { exportAttempts: opts.attempts }),
            now: () => FINALIZED + 8 * 24 * HOUR,
            log: (m) => logs.push(m),
            observe: {
                sweep: (outcome) => void outcomes.push(outcome),
                scanned: () => undefined,
                volumeExport: (result) => void (result === 'lost' ? lost.push(result) : undefined),
            },
        });
        const sweepAgain = async () => {
            calls.clear();
            await reaper.sweep();
        };
        return { reaper, events, logs, outcomes, exports, lost, sweepAgain };
    };
    const stable = (facts: BoardThreadFacts) => (root: string) => rowOf(root, facts);

    it('exports the newest attempt of a not-whole thread before reaping its volumes', async () => {
        const facts = thread({ ...NOT_WHOLE, lastJobId: JOB_B, lastClaimSeq: 4 });
        const h = harness({ listed: [volumesOf(ROOT_A)], answer: stable(facts) });
        await h.reaper.sweep();
        expect(h.events).toEqual([`export ${ROOT_A}`, `reap ${ROOT_A}`]);
        expect(h.exports[0]!.attempt).toEqual({ jobId: JOB_B, claimSeq: 4 });
        expect(h.outcomes).toEqual(['ok']);
    });

    it.each([
        ['inconclusive', { result: 'inconclusive', why: 'the pod answered 403' } as const],
        ['never started', { result: 'never_started', why: 'the pod stayed pending' } as const],
    ])('keeps the volumes when the re-export is %s, and the round is not ok', async (_name, answer) => {
        const h = harness({
            listed: [volumesOf(ROOT_A)],
            answer: stable(thread(NOT_WHOLE)),
            exported: async () => answer,
        });
        await h.reaper.sweep();
        expect(h.events).toEqual([`export ${ROOT_A}`]);
        expect(h.outcomes).toEqual(['aborted']);
        expect(h.logs.join('\n')).toContain(answer.why);
    });

    it('keeps the volumes when the re-export throws', async () => {
        const h = harness({
            listed: [volumesOf(ROOT_A)],
            answer: stable(thread(NOT_WHOLE)),
            exported: async () => {
                throw new Error('the daemon went away');
            },
        });
        await h.reaper.sweep();
        expect(h.events).toEqual([`export ${ROOT_A}`]);
        expect(h.outcomes).toEqual(['aborted']);
        expect(h.logs.join('\n')).toContain('the daemon went away');
    });

    it('keeps a thread that was claimed while it was exporting', async () => {
        const h = harness({
            listed: [volumesOf(ROOT_A)],
            // Call 0 the batch, 1 the read before the export, 2 the read after it.
            answer: (root, call) => rowOf(root, thread(call < 2 ? NOT_WHOLE : { ...NOT_WHOLE, live: true })),
        });
        await h.reaper.sweep();
        expect(h.events).toEqual([`export ${ROOT_A}`]);
    });

    it('keeps a thread that a newer attempt took over while it was exporting', async () => {
        const h = harness({
            listed: [volumesOf(ROOT_A)],
            answer: (root, call) => rowOf(root, thread({ ...NOT_WHOLE, lastClaimSeq: call < 2 ? 1 : 2 })),
        });
        await h.reaper.sweep();
        expect(h.events).toEqual([`export ${ROOT_A}`]);
    });

    it('does not export a thread found live on the read before the export', async () => {
        const h = harness({
            listed: [volumesOf(ROOT_A)],
            answer: (root, call) => rowOf(root, thread(call === 0 ? NOT_WHOLE : { ...NOT_WHOLE, live: true })),
        });
        await h.reaper.sweep();
        expect(h.events).toEqual([]);
    });

    it('regression: a whole thread is deleted without an export', async () => {
        const h = harness({ listed: [volumesOf(ROOT_A)], answer: stable(thread()) });
        await h.reaper.sweep();
        expect(h.events).toEqual([`reap ${ROOT_A}`]);
    });

    it('deletes a not-whole thread nothing ever claimed without an export: no runner wrote a transcript', async () => {
        const never = thread({ ...NOT_WHOLE, lastJobId: null, lastClaimSeq: null });
        const h = harness({ listed: [volumesOf(ROOT_A)], answer: stable(never) });
        await h.reaper.sweep();
        expect(h.events).toEqual([`reap ${ROOT_A}`]);
    });

    it('regression: a thread with no board row is deleted without an export', async () => {
        const h = harness({
            listed: [{ root: ROOT_A, volumes: [{ name: 'v', createdAtMs: FINALIZED }] }],
            answer: () => undefined,
        });
        await h.reaper.sweep();
        expect(h.events).toEqual([`reap ${ROOT_A}`]);
    });

    it('regression: an arm that cannot export deletes as before', async () => {
        const h = harness({ listed: [volumesOf(ROOT_A)], answer: stable(thread(NOT_WHOLE)), withExportArm: false });
        await h.reaper.sweep();
        expect(h.events).toEqual([`reap ${ROOT_A}`]);
    });

    it('exports one thread per round, deleting the whole ones meanwhile, and the rest on the next round', async () => {
        const OTHER = '55555555-5555-4555-8555-555555555555';
        const WHOLE = '66666666-6666-4666-8666-666666666666';
        const h = harness({
            listed: [volumesOf(ROOT_A), volumesOf(OTHER), volumesOf(WHOLE)],
            answer: (root) => rowOf(root, root === WHOLE ? thread() : thread(NOT_WHOLE)),
        });
        await h.reaper.sweep();
        expect(h.events).toEqual([`export ${ROOT_A}`, `reap ${ROOT_A}`, `reap ${WHOLE}`]);
        await h.sweepAgain();
        expect(h.events.slice(3)).toEqual([`export ${OTHER}`, `reap ${OTHER}`]);
    });

    describe('retries (TASK_VOLUME_EXPORT_ATTEMPTS)', () => {
        const failing = async (): Promise<Exported> => ({ result: 'inconclusive', why: 'the board refused a chunk' });

        it('keeps the volumes for N-1 failed attempts, then deletes them and logs the loss', async () => {
            const h = harness({
                listed: [volumesOf(ROOT_A)],
                answer: stable(thread(NOT_WHOLE)),
                exported: failing,
                attempts: 3,
            });
            await h.reaper.sweep();
            await h.reaper.sweep();
            expect(h.events).toEqual([`export ${ROOT_A}`, `export ${ROOT_A}`]);
            expect(h.lost).toEqual([]);
            await h.reaper.sweep();
            expect(h.events.slice(2)).toEqual([`export ${ROOT_A}`, `reap ${ROOT_A}`]);
            expect(h.lost).toEqual(['lost']);
            const loud = h.logs.find((line) => line.includes('LOST'));
            expect(loud).toContain(ROOT_A);
            expect(loud).toContain('3 export attempts');
            expect(loud).toContain('the board refused a chunk');
        });

        it('counts a never-started attempt as a failed one', async () => {
            const h = harness({
                listed: [volumesOf(ROOT_A)],
                answer: stable(thread(NOT_WHOLE)),
                exported: async () => ({ result: 'never_started', why: 'no pod' }),
                attempts: 1,
            });
            await h.reaper.sweep();
            expect(h.events).toEqual([`export ${ROOT_A}`, `reap ${ROOT_A}`]);
            expect(h.lost).toEqual(['lost']);
        });

        it('counts failures per thread root, one export a round', async () => {
            const OTHER = '55555555-5555-4555-8555-555555555555';
            const h = harness({
                listed: [volumesOf(ROOT_A), volumesOf(OTHER)],
                answer: stable(thread(NOT_WHOLE)),
                exported: async (root) => (root === OTHER ? { result: 'drained' } : failing()),
                attempts: 2,
            });
            await h.reaper.sweep(); // A fails once; the one export of the round was A's
            await h.sweepAgain(); // A fails twice and is deleted as a loss
            expect(h.events).toEqual([`export ${ROOT_A}`, `export ${ROOT_A}`, `reap ${ROOT_A}`]);
            expect(h.lost).toEqual(['lost']);
        });

        it('does not count a contended export as a failed attempt: another replica holds the workload', async () => {
            const h = harness({
                listed: [volumesOf(ROOT_A)],
                answer: stable(thread(NOT_WHOLE)),
                exported: async () => ({ result: 'contended', why: 'another export holds the name' }),
                attempts: 1,
            });
            await h.reaper.sweep();
            await h.sweepAgain();
            expect(h.events).toEqual([`export ${ROOT_A}`, `export ${ROOT_A}`]);
            expect(h.lost).toEqual([]);
            expect(h.outcomes).toEqual(['aborted', 'aborted']);
        });

        it('forgets the attempts of a thread whose volume is gone', async () => {
            const listed = [volumesOf(ROOT_A)];
            const h = harness({ listed, answer: stable(thread(NOT_WHOLE)), exported: failing, attempts: 2 });
            await h.reaper.sweep(); // one failed attempt
            listed.length = 0; // deleted by another replica
            await h.reaper.sweep();
            listed.push(volumesOf(ROOT_A)); // a new thread under the same root
            await h.reaper.sweep(); // the count starts over: attempt 1 of 2 again
            expect(h.events).toEqual([`export ${ROOT_A}`, `export ${ROOT_A}`]);
            expect(h.lost).toEqual([]);
        });

        it('keeps counting when the delete after the last attempt was unconfirmed', async () => {
            const h = harness({
                listed: [volumesOf(ROOT_A)],
                answer: stable(thread(NOT_WHOLE)),
                exported: failing,
                attempts: 1,
                reapAnswer: () => ({ removed: [], inconclusive: 'the daemon timed out' }),
            });
            await h.reaper.sweep(); // attempt 1 fails: the delete is tried and unconfirmed
            await h.sweepAgain(); // no further export: the delete is retried straight away
            expect(h.events).toEqual([`export ${ROOT_A}`, `reap ${ROOT_A}`, `reap ${ROOT_A}`]);
        });

        it('treats a read that cannot confirm the thread after the last attempt as a keep', async () => {
            let reads = 0;
            const h = harness({
                listed: [volumesOf(ROOT_A)],
                answer: (root) => (++reads > 2 ? undefined : rowOf(root, thread(NOT_WHOLE))),
                exported: failing,
                attempts: 1,
            });
            await h.reaper.sweep();
            expect(h.events).toEqual([`export ${ROOT_A}`]);
        });
    });

    it('aborts a running export on stop(), keeping the volumes', async () => {
        let aborted: Promise<void> | null = null;
        const h = harness({
            listed: [volumesOf(ROOT_A)],
            answer: stable(thread(NOT_WHOLE)),
            exported: (_root, signal) => {
                aborted = new Promise((resolve) => signal.addEventListener('abort', () => resolve()));
                return aborted.then(() => ({ result: 'inconclusive', why: 'aborted' }));
            },
        });
        const sweeping = h.reaper.sweep();
        await vi.waitFor(() => expect(h.exports).toHaveLength(1));
        h.reaper.stop();
        await sweeping;
        expect(h.exports[0]!.signal.aborted).toBe(true);
        expect(h.events).toEqual([`export ${ROOT_A}`]);
        expect(h.outcomes).toEqual(['aborted']);
        // An abort is not a failed attempt: the volume still gets all its attempts.
        expect(h.lost).toEqual([]);
    });
});

describe('the reaper observer (issue #831)', () => {
    const observed = () => {
        const sweeps: { outcome: string; seconds: number }[] = [];
        const scanned: { what: string; n: number }[] = [];
        return {
            sweeps,
            scanned,
            observe: {
                sweep: (outcome: 'ok' | 'aborted' | 'error', seconds: number) => void sweeps.push({ outcome, seconds }),
                scanned: (what: 'groups' | 'objects' | 'volume_threads', n: number) => void scanned.push({ what, n }),
            },
        };
    };
    const reaperWith = (
        arm: ReaperArm,
        board: ReturnType<typeof boardOf>,
        observe: ReturnType<typeof observed>['observe']
    ) =>
        createReaper({
            board,
            arm,
            intervalMs: 3_600_000,
            graceMs: GRACE,
            now: () => NOW,
            log: () => undefined,
            observe,
        });

    it('reports ok with what the scan found', async () => {
        const { arm } = recordingArm();
        arm.scan = async () => [group(), group({ jobId: JOB_B })];
        const seen = observed();
        await reaperWith(arm, boardOf([]), seen.observe).sweep();
        expect(seen.sweeps.map((s) => s.outcome)).toEqual(['ok']);
        expect(seen.sweeps[0]!.seconds).toBeGreaterThanOrEqual(0);
        expect(seen.scanned).toContainEqual({ what: 'groups', n: 2 });
        expect(seen.scanned).toContainEqual({ what: 'objects', n: 2 });
    });

    it('reports aborted, not ok, when the board could not prove absence', async () => {
        const { arm } = recordingArm();
        arm.scan = async () => [group()];
        const seen = observed();
        await reaperWith(arm, boardOf(null), seen.observe).sweep();
        expect(seen.sweeps.map((s) => s.outcome)).toEqual(['aborted']);
    });

    it('reports aborted when the task volumes could not be listed', async () => {
        const { arm } = recordingArm();
        arm.scanVolumes = async () => null;
        arm.reapVolumes = async () => [];
        const seen = observed();
        const reaper = createReaper({
            board: boardOf([]),
            arm,
            intervalMs: 3_600_000,
            graceMs: GRACE,
            now: () => NOW,
            log: () => undefined,
            volumePolicy: { ttlMs: 1, boundMs: 1 },
            observe: seen.observe,
        });
        await reaper.sweep();
        expect(seen.sweeps.map((s) => s.outcome)).toEqual(['aborted']);
    });

    it('reports error when the sweep throws, still exactly once', async () => {
        const { arm } = recordingArm();
        arm.scan = async () => {
            throw new Error('daemon down');
        };
        const seen = observed();
        await reaperWith(arm, boardOf([]), seen.observe).sweep();
        expect(seen.sweeps.map((s) => s.outcome)).toEqual(['error']);
    });
});
