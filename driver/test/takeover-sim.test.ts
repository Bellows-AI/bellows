/**
 * Driver loss, takeover and adoption (#829) in seconds: the kind lane's takeover and recovery cases
 * (`scripts/test-k8s.sh`, t1-t5 and the drain) against a compressed world (`fixtures/takeover-sim.ts`),
 * each across a timing matrix of lease, rebind grace and the kubelet's Secret refresh. A scenario
 * names the lane case it mirrors; its expectations are the lane's.
 */
import { describe, expect, it } from 'vitest';
import { ADOPTED, scaled, Sim, TOOK_OVER, type Timing, until } from './fixtures/takeover-sim.js';

const released = (s: Sim) => [...s.groups.values()].find((g) => s.released(g));
const firstGroup = (s: Sim) => [...s.groups.values()][0]!;
const settled = (s: Sim) => until('the job to settle', s, () => s.row.status === 'succeeded', 25_000);

const scenarios: Record<string, (s: Sim) => Promise<void>> = {
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
        await until('the group to end', s, () => g.exit !== null, 25_000);
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

// The kind lane runs lease 45 s / grace 20 s / refresh 10 s (2 x the 5 s kubelet sync); each row is that
// divided down (not past /15: a 2 s lease is inside the scheduling jitter of a loaded host), then the relations the lane's numbers hide: a refresh longer than the grace, a short lease.
const matrix: [string, Timing][] = [
    ['lane / 15', scaled(15)],
    ['lane / 9', scaled(9)],
    ['refresh 2 x grace', { ...scaled(15), refreshMs: 2 * scaled(15).rebindGraceMs }],
    ['grace under the control poll', { ...scaled(15), rebindGraceMs: 1_000, refreshMs: 700, controlMs: 800 }],
];

describe.each(matrix)('takeover simulation, %s', (_name, timing) => {
    describe.concurrent.each(Object.entries(scenarios))('%s', (_scenario, play) => {
        it('holds', async () => {
            const s = new Sim(timing);
            try {
                await play(s);
            } finally {
                await s.teardown();
            }
        }, 40_000);
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
