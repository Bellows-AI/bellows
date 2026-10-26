/**
 * Driver loss, takeover and adoption (#829) in seconds: the kind lane's takeover and recovery cases
 * (`scripts/test-k8s.sh`, t1-t5 and the drain) against a compressed world (`fixtures/takeover-sim.ts`),
 * each across a timing matrix of lease, rebind grace and the kubelet's Secret refresh. A scenario
 * names the lane case it mirrors; its expectations are the lane's.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { AGENT_MAILBOX_DIR, MAILBOX_FILES } from '../src/supervisor-contract.js';
import { takeoverBoundMs } from '../src/supervisor-plan.js';
import { busyWait } from './fixtures/host-stall.js';
import { liveSupervisors } from './fixtures/supervisor-tracker.js';
import {
    ADOPTED,
    type Group,
    lane15,
    nap,
    scaled,
    Sim,
    TOOK_OVER,
    type Timing,
    until,
} from './fixtures/takeover-sim.js';

afterAll(() => expect(liveSupervisors()).toBe(0));

const released = (s: Sim) => [...s.groups.values()].find((g) => s.released(g));
const firstGroup = (s: Sim) => [...s.groups.values()][0]!;
const settled = (s: Sim) =>
    until('the job to settle', s, () => s.row.status === 'succeeded', 25_000 + takeoverBoundMs(s.config));

/** `GET /attempt` on a group's agent relay: the status and lease the supervisor answers. */
const attemptOf = (g: Group) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(
            { socketPath: join(g.root, 'out', AGENT_MAILBOX_DIR, MAILBOX_FILES.relay), path: '/attempt' },
            (res) => {
                let body = '';
                res.on('data', (chunk) => (body += chunk));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
            }
        );
        req.on('error', reject);
        req.end();
    });

const scenarios: Record<string, (s: Sim) => Promise<void>> = {
    // #1045: the adopted runner's helpers read the new claim's lease from its supervisor, not their env.
    "t2: after the takeover the agent's /attempt answers the new claim's lease": async (s) => {
        s.release();
        const a = await s.start('A');
        await until('the agent released', s, () => Boolean(released(s)));
        const g = firstGroup(s);
        expect((await attemptOf(g)).status).toBe(404);
        await s.kill(a);
        s.expireLease();
        await s.start('B');
        await until('the rebind', s, () => g.logs.some((l) => l.startsWith('supervisor: rebound to claim 2')));
        expect(g.lease).not.toBe(s.row.leaseToken);
        expect(await attemptOf(g)).toEqual({
            status: 200,
            body: JSON.stringify({ leaseToken: s.row.leaseToken }),
        });
        s.agentExits(g, 0);
        await settled(s);
        expect(s.text()).not.toContain(s.row.leaseToken ?? 'unreachable');
    },

    't2: a hard kill while the agent runs: the next claim takes the running agent over': async (s) => {
        s.release();
        const a = await s.start('A');
        await until('the agent released', s, () => Boolean(released(s)));
        const g = firstGroup(s);
        await s.kill(a);
        s.expireLease();
        await s.start('B');
        await until('the rebind', s, () => g.logs.some((l) => l.startsWith('supervisor: rebound to claim 2')));
        s.agentExits(g, 0);
        await settled(s);
        expect(s.brief()).toBe('succeeded|1|1');
        expect(s.text()).toContain(TOOK_OVER);
        expect([s.spawned, s.agentRuns]).toEqual([1, 1]);
    },

    't5: the agent exited and the supervisor serves the publish when the driver is lost': async (s) => {
        const a = await s.start('A');
        await until('the agent released', s, () => Boolean(released(s)));
        s.agentExits(firstGroup(s), 0);
        await until('the publish at the hold', s, () => s.pubRuns() >= 1);
        await s.kill(a);
        await s.start('B');
        s.expireLease();
        s.release();
        await settled(s);
        expect(s.brief()).toBe('succeeded|1|1');
        expect(s.text()).toContain(TOOK_OVER);
        expect(s.text()).not.toContain(ADOPTED);
        expect([s.pubRuns(), s.spawned, s.agentRuns]).toEqual([1, 1, 1]);
    },

    't5 with the lost driver alive past the hold: nothing is taken over, the old claim finishes': async (s) => {
        const a = await s.start('A');
        await until('the agent released', s, () => Boolean(released(s)));
        s.agentExits(firstGroup(s), 0);
        await until('the publish at the hold', s, () => s.pubRuns() >= 1);
        s.claimsOff = true; // no replacement, and the old driver's own claim poll must not race its heartbeat
        void s.kill(a, 60_000); // the pod object is deleted, the process is not stopped yet
        s.expireLease();
        s.release();
        // No replacement polls in this case: the board takes the old claim's verdict while its lease is expired
        // but unreclaimed, so with a replacement the outcome is a race between its claim and the old driver's
        // complete. What is pinned is the outcome when the old driver wins it.
        await settled(s);
        // The lane's row for this: the old driver's heartbeat renewed the expired lease before any claim.
        expect(s.brief()).toBe('succeeded|0|');
        expect(s.text()).not.toContain(TOOK_OVER);
    },

    'drain: no holder until the group ends: the next claim adopts the finished runner': async (s) => {
        s.release();
        const a = await s.start('A');
        await until('the agent released', s, () => Boolean(released(s)));
        const g = firstGroup(s);
        await a.loop.handover('the driver is draining');
        await s.kill(a);
        s.agentExits(g, 0);
        await until('the group to end', s, () => g.exit !== null, 25_000 + takeoverBoundMs(s.config));
        await s.start('B');
        await settled(s);
        expect(s.brief()).toBe('succeeded|1|1');
        expect(s.text()).toContain(ADOPTED);
        expect([s.spawned, s.agentRuns]).toEqual([1, 1]);
    },

    't1: lost before the agent is released: the group is redone, and was not yet over when the next claim swept it':
        async (s) => {
            let open!: () => void;
            s.goGate = new Promise<void>((resolve) => (open = resolve));
            s.release();
            const a = await s.start('A');
            await until('the group', s, () => s.groups.size === 1);
            const g = firstGroup(s);
            await s.kill(a);
            s.expireLease();
            open();
            await s.start('B');
            await until('the redo released', s, () => s.spawned === 2 && Boolean(released(s)));
            s.agentExits([...s.groups.values()].find((x) => x !== g)!, 0);
            await settled(s);
            expect(s.brief()).toBe('succeeded|1|1');
            expect(s.text()).not.toContain(TOOK_OVER);
            // The lane's t1 wants exit 75 (the supervisor ended lost by itself); the sweep came first.
            expect(s.sweptAt).toEqual([{ exit: null }]);
        },

    't1: lost before the agent is released: the supervisor ends lost (75) at its orphan bound, then the next claim redoes the group':
        async (s) => {
            let open!: () => void;
            s.goGate = new Promise<void>((resolve) => (open = resolve));
            s.release();
            const a = await s.start('A');
            await until('the group', s, () => s.groups.size === 1);
            const g = firstGroup(s);
            await s.kill(a);
            // The lane waits for the lost group's own end before the lease is expired and the next claim sweeps it.
            await until('the supervisor to end lost', s, () => g.exit !== null, 25_000);
            expect(g.exit).toBe(75);
            s.expireLease();
            open();
            await s.start('B');
            await until('the redo released', s, () => s.spawned === 2 && Boolean(released(s)));
            s.agentExits([...s.groups.values()].find((x) => x !== g)!, 0);
            await settled(s);
            expect(s.brief()).toBe('succeeded|1|1');
            expect(s.sweptAt).toEqual([]);
        },

    'lost together: the group is gone with the driver: the task is redone, one interruption': async (s) => {
        s.release();
        const a = await s.start('A');
        await until('the agent released', s, () => Boolean(released(s)));
        s.deleteGroup(firstGroup(s));
        await s.kill(a);
        s.expireLease();
        await s.start('B');
        await until('the redo released', s, () => s.spawned === 2 && Boolean(released(s)));
        s.agentExits([...s.groups.values()][0]!, 0);
        await settled(s);
        expect(s.brief()).toBe('succeeded|1|1');
        expect(s.agentRuns).toBe(2);
    },
};

// The kind lane ran lease 45 s / grace 20 s / refresh 10 s (2 x the 5 s kubelet sync); each row is that
// divided down (not past /15: a 2 s lease is inside the scheduling jitter of a loaded host), then the relations the lane's numbers hide: a refresh longer than the grace, a short lease.
const matrix: [string, Timing][] = [
    ['lane / 15', scaled(15)],
    ['lane / 9', scaled(9)],
    ['refresh 2 x grace', { ...scaled(15), refreshMs: 2 * scaled(15).rebindGraceMs }],
    ['grace under the control poll', { ...scaled(15), rebindGraceMs: 1_000, refreshMs: 700, controlMs: 800 }],
    // #950: the lane's 15 s lease in real time (a 10 s orphan bound over a 2 s long poll), from the production derivation.
    ['lane 15 s lease', lane15()],
];

describe.each(matrix)('takeover simulation, %s', (_name, timing) => {
    describe.concurrent.each(Object.entries(scenarios))('%s', (_scenario, play) => {
        it(
            'holds',
            async () => {
                const s = new Sim(timing);
                try {
                    await play(s);
                } finally {
                    await s.teardown();
                }
            },
            40_000 + 2 * (timing.leaseSeconds * 1000 + timing.rebindGraceMs)
        );
    });
});

// #928: the rebound binding reaches the supervisor only after the kubelet's Secret refresh. Where that is
// longer than the supervisor's orphan bound it has stopped serving and wound down by then, so it never
// polls the new endpoint: the earlier group is confirmed finished, and the claim must not wait the rebind bound.
describe('takeover simulation, a supervisor that wound down before the rebind reached it (#928)', () => {
    it('the supervisor stopped serving before the rebind reached it: the next claim adopts the finished runner', async () => {
        const base = scaled(15);
        const s = new Sim({ ...base, refreshMs: 3 * base.orphanMs });
        try {
            s.release();
            const a = await s.start('A');
            await until('the agent released', s, () => Boolean(released(s)));
            const g = firstGroup(s);
            await s.kill(a);
            s.agentExits(g, 0);
            s.expireLease();
            await s.start('B');
            await settled(s);
            expect(s.brief()).toBe('succeeded|1|1');
            expect(s.text()).toContain(ADOPTED);
            expect([s.spawned, s.agentRuns]).toEqual([1, 1]);
        } finally {
            await s.teardown();
        }
    }, 40_000);
});

// #943: a pod evicted after the takeover wrote its rebind and before the Secret refresh reached it is gone with its
// supervisor. The simulation runs that supervisor in this process, so it must not outlive the pod's deletion and follow
// the late binding: it would answer the redo's token as a pod of its own, and the redo's real group would be
// left running, never reached.
describe('takeover simulation, a pod evicted under a takeover (#943)', () => {
    it('the evicted pod does not follow the late rebind: the redo is served by its own group', async () => {
        const base = scaled(15);
        const s = new Sim({ ...base, refreshMs: 1_200 });
        // The redo's pod is slow to come up: the late binding lands while only the evicted pod's supervisor could answer.
        s.place = (g) => {
            setTimeout(() => g.start(), s.spawned === 1 ? 0 : 3_000);
            return 'N';
        };
        try {
            s.release();
            const a = await s.start('A');
            await until('the agent released', s, () => Boolean(released(s)));
            const g = firstGroup(s);
            await s.kill(a);
            s.expireLease();
            await s.start('B');
            await until('the rebind written', s, () => g.secretWrites >= 1);
            s.deleteGroup(g);
            await new Promise((resolve) => setTimeout(resolve, 2_000));
            await until('the redo released', s, () => s.spawned === 2 && Boolean(released(s)), 25_000);
            const redo = [...s.groups.values()].find((x) => x !== g)!;
            s.agentExits(redo, 0);
            // The evicted pod's agent ends too, so its cut-off supervisor winds down before the teardown.
            s.agentExits(g, 0);
            await settled(s);
            await until('no group left running', s, () => [...s.groups.values()].every((x) => x.exit !== null), 8_000);
            await until('the evicted supervisor to end', s, () => g.exit !== null, 15_000);
            expect(g.logs.some((l) => l === 'supervisor: rebound to claim 2')).toBe(false);
            expect(s.brief()).toBe('succeeded|1|1');
            expect(s.agentRuns).toBe(2);
        } finally {
            await s.teardown();
        }
    }, 60_000);

    it('a binding refresh still pending at the teardown never writes into the removed group', async () => {
        const s = new Sim({ ...scaled(1), refreshMs: 50 });
        const dir = mkdtempSync(join(tmpdir(), 'takeover-refresh-'));
        s.dirs.push(dir);
        const file = join(dir, 'binding.json');
        s.groups.set('lease', { secretWrites: 0, tokens: new Set<string>(), file } as unknown as Group);
        s.rebind('lease', JSON.stringify({ token: 't' }));
        await s.teardown();
        // An uncaught ENOENT from the timer fails the run; the file must not reappear either.
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(existsSync(file)).toBe(false);
    });
});

// #972: the simulated board shares this process with every driver and supervisor, so a host stall holds them all. The
// lease is judged against loop time, which a stall does not advance; a lease nobody renews still lapses in it.
describe('takeover simulation, the board clock under a host stall (#972)', () => {
    const lease = { ...scaled(15), leaseSeconds: 1 };

    it('a stall longer than the lease is not a lapse: the next claim finds the lease held', async () => {
        const s = new Sim(lease);
        try {
            const board = s.directBoard();
            const job = (await board.claim!({} as never)) as BoardJob;
            busyWait(2.5 * lease.leaseSeconds * 1000);
            expect(await board.claim!({} as never)).toBeNull();
            expect(s.brief()).toBe('running|0|');
            expect(s.holds(job)).toBe(true);
        } finally {
            await s.teardown();
        }
    });

    it('the same holds once the watcher has recorded the stall', async () => {
        const s = new Sim(lease);
        try {
            const board = s.directBoard();
            await board.claim!({} as never);
            busyWait(2.5 * lease.leaseSeconds * 1000);
            await nap(100);
            expect(s.host.stalls.length).toBeGreaterThan(0);
            expect(await board.claim!({} as never)).toBeNull();
            expect(s.brief()).toBe('running|0|');
        } finally {
            await s.teardown();
        }
    });

    it('a lease nobody renews still lapses in loop time and the claim records the interruption', async () => {
        const s = new Sim(lease);
        try {
            const board = s.directBoard();
            await board.claim!({} as never);
            const claimed = s.host.loopNow();
            // Loop time, not the wall clock: a stall of a loaded host in this wait lengthens it, and the lease still lapses.
            while (s.host.loopNow() - claimed < lease.leaseSeconds * 1000 + 100) await nap(20);
            const next = (await board.claim!({} as never)) as BoardJob | null;
            expect(next?.claimSeq).toBe(2);
            expect(s.brief()).toBe('running|1|1');
        } finally {
            await s.teardown();
        }
    });

    it('a driver whose host stalls past the lease keeps its claim: nothing is interrupted', async () => {
        const s = new Sim({ ...lease, orphanMs: 30_000, rebindGraceMs: 30_000 });
        try {
            s.release();
            await s.start('A');
            await until('the agent released', s, () => Boolean(released(s)));
            busyWait(2.5 * lease.leaseSeconds * 1000);
            s.agentExits(firstGroup(s), 0);
            await settled(s);
            expect(s.brief()).toBe('succeeded|0|');
            expect(s.agentRuns).toBe(1);
        } finally {
            await s.teardown();
        }
    }, 40_000);
});
