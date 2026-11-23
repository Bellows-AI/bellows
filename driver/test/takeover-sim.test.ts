/**
 * Driver loss, takeover and adoption in seconds: the kind lane's takeover and recovery cases
 * (`scripts/test-k8s.sh`, t1-t5 and the drain) against a compressed world (`fixtures/takeover-sim.ts`),
 * each across a timing matrix of lease, rebind grace and the kubelet's Secret refresh. A scenario
 * names the lane case it mirrors; its expectations are the lane's.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { AGENT_MAILBOX_DIR, MAILBOX_FILES } from '../src/supervisor-contract.js';
import { takeoverBoundMs } from '../src/supervisor-plan.js';
import { busyWait } from './fixtures/host-stall.js';
import { REPO_ROOT } from './fixtures/repo-files.js';
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
/** Until a verdict lands; it must be a success (the board records the reported status, a failure included). */
const settled = async (s: Sim) => {
    await until(
        'the job to settle',
        s,
        () => s.row.status !== 'queued' && s.row.status !== 'running',
        25_000 + takeoverBoundMs(s.config)
    );
    expect(s.row.status, `${s.brief()}\n${s.text()}`).toBe('succeeded');
};

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

/** `POST /gate/run` on a group's agent relay, the way the agent's gate and exec tools reach their driver. */
const gateRunOf = (g: Group, gate: string | { exec: string }) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(
            {
                socketPath: join(g.root, 'out', AGENT_MAILBOX_DIR, MAILBOX_FILES.relay),
                path: '/gate/run',
                method: 'POST',
                headers: { 'content-type': 'application/json' },
            },
            (res) => {
                let body = '';
                res.on('data', (chunk) => (body += chunk));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
            }
        );
        req.on('error', reject);
        req.end(JSON.stringify(typeof gate === 'string' ? { gate } : gate));
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

    // Infrastructure loss after the board wrote the PR: the driver that asked is gone before it heard the answer. The
    // next claim's publish asks again and the board finds the PR by its head, so one PR exists however the loss fell.
    't5b: the board created the PR and the driver was lost before the answer: the next claim reuses it, one create':
        async (s) => {
            s.release();
            let open: () => void = () => undefined;
            s.prAnswerGate = new Promise<void>((resolve) => {
                open = resolve;
            });
            const a = await s.start('A');
            await until('the agent released', s, () => Boolean(released(s)));
            s.agentExits(firstGroup(s), 0);
            await until('the board to create the PR', s, () => s.prCreates >= 1);
            await s.kill(a);
            s.expireLease();
            open();
            await s.start('B');
            await settled(s);
            expect(s.prCreates).toBe(1);
            expect(s.prs.size).toBe(1);
            expect(s.prAsks.length).toBeGreaterThanOrEqual(2);
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

// A revoked driver credential: the driver process runs on, and every board call it makes is answered 401. That is no
// verdict on the run: the driver stops claiming, its lease lapses unrenewed, it stands down without ending the
// runner, and the next driver's claim takes the running agent over under a new claim sequence. Kubernetes delivers
// the rebind through the binding Secret's refresh; docker writes the binding into the group at once.
describe.each<[string, Timing]>([
    ['kubernetes, the binding Secret refreshed', scaled(15)],
    ['docker, the binding written at once', { ...scaled(15), refreshMs: 0 }],
])('takeover simulation, a revoked driver credential (%s)', (_executor, timing) => {
    it('the revoked driver stands down and claims nothing; the next driver takes the running agent over', async () => {
        const s = new Sim(timing);
        try {
            s.release();
            const a = await s.start('A');
            await until('the agent released', s, () => Boolean(released(s)));
            const g = firstGroup(s);
            s.revoked.add(a);
            await until('the revoked driver to stand down', s, () => s.text().includes('lease lapsed'));
            await s.start('B');
            await until('the rebind', s, () => g.logs.some((l) => l.startsWith('supervisor: rebound to claim 2')));
            s.agentExits(g, 0);
            await settled(s);
            expect(s.brief()).toBe('succeeded|1|1');
            expect(s.text()).toContain(TOOK_OVER);
            // The runner survived the revocation: one group, one agent run, and nothing ended it.
            expect([s.spawned, s.agentRuns]).toEqual([1, 1]);
            expect(s.driverKills).toEqual([]);
            // The revoked driver claimed nothing more; the new claim moved the sequence.
            expect(s.claimSeqs).toEqual([1, 2]);
            expect(a.dead).toBe(false);
        } finally {
            await s.teardown();
        }
    }, 60_000);
});

// The same process re-claims: its credential is restored after its lease lapsed, and it takes over the agent it
// abandoned under the earlier claim. That abandonment is the earlier attempt's alone; the takeover follows the run
// to its own report and never tears the group down under it.
describe.each<[string, Timing, 'kubernetes' | 'docker']>([
    ['kubernetes, the binding Secret refreshed', scaled(15), 'kubernetes'],
    ['docker, the binding written at once', { ...scaled(15), refreshMs: 0 }, 'docker'],
])('takeover simulation, a revoked driver credential restored (%s)', (_name, timing, executor) => {
    it('the revoked driver, its credential restored, takes its own running agent over and the task succeeds', async () => {
        const s = new Sim(timing, { executor });
        try {
            s.release();
            const a = await s.start('A');
            await until('the agent released', s, () => Boolean(released(s)));
            const g = firstGroup(s);
            s.revoked.add(a);
            await until('the revoked driver to stand down', s, () => s.text().includes('lease lapsed'));
            s.revoked.delete(a);
            await until('the rebind', s, () => g.logs.some((l) => l.startsWith('supervisor: rebound to claim 2')));
            // The agent runs on past the takeover's launch: the claim follows it, it does not read a finished run.
            await until('the takeover launched', s, () =>
                s.text().includes('"claimSeq":2,"from":"setup","to":"launched"')
            );
            await nap(200);
            s.agentExits(g, 0);
            await settled(s);
            expect(s.brief()).toBe('succeeded|1|1');
            expect(s.row.exitCode).toBe(0);
            expect(s.text()).toContain(TOOK_OVER);
            expect([s.spawned, s.agentRuns]).toEqual([1, 1]);
            expect(s.driverKills).toEqual([]);
            // The group was never ended under its running agent: only once the agent's own exit was in.
            expect(s.finished.filter((f) => f.agentRunning)).toEqual([]);
            expect(s.claimSeqs).toEqual([1, 2]);
            expect(s.drivers).toEqual([a]);
        } finally {
            await s.teardown();
        }
    }, 60_000);
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

describe("takeover simulation, the agent's gate request", () => {
    it('a job that declares no gates answers its agent\'s gate request "no gates"', async () => {
        const s = new Sim(scaled(15));
        try {
            s.release();
            await s.start('A');
            await until('the agent released', s, () => Boolean(released(s)));
            const g = firstGroup(s);
            const answer = await gateRunOf(g, 'verify');
            expect(answer.status).toBe(404);
            expect(JSON.parse(answer.body)).toEqual({ error: 'no gates' });
            s.agentExits(g, 0);
            await settled(s);
        } finally {
            await s.teardown();
        }
    }, 40_000);

    it("a taken-over run's agent gate request reaches the new holder", async () => {
        const s = new Sim(scaled(15), { gated: true });
        try {
            s.release();
            const a = await s.start('A');
            await until('the agent released', s, () => Boolean(released(s)));
            const g = firstGroup(s);
            await s.kill(a);
            s.expireLease();
            await s.start('B');
            await until('the rebind', s, () => g.logs.some((l) => l.startsWith('supervisor: rebound to claim 2')));
            // The new holder registers its gate claim a moment after the rebind: until then the answer is a retryable 503.
            let answer = await gateRunOf(g, 'verify');
            for (let tries = 0; answer.status === 503 && tries < 200; tries++) {
                await nap(20);
                answer = await gateRunOf(g, 'verify');
            }
            expect(answer.status).toBe(200);
            expect(JSON.parse(answer.body)).toMatchObject({ exitCode: 0, output: 'ran on driver B' });
            expect(s.gateRuns).toEqual([{ driver: 'B', command: 'verify-it' }]);
            // The agent never held a gate URL or token to go stale: nothing in its env names the lost driver's endpoint.
            expect(s.runnerEnvs.length).toBeGreaterThan(0);
            for (const { body } of s.runnerEnvs) expect(body).not.toMatch(/BELLOWS_GATE_/);
            s.agentExits(g, 0);
            await settled(s);
        } finally {
            await s.teardown();
        }
    }, 40_000);

    // An exec rides the same relay, so a re-ask after the takeover runs on the new holder.
    it("a taken-over run's agent exec reaches the new holder", async () => {
        const s = new Sim(scaled(15), { gated: true });
        try {
            s.release();
            const a = await s.start('A');
            await until('the agent released', s, () => Boolean(released(s)));
            const g = firstGroup(s);
            await s.kill(a);
            s.expireLease();
            await s.start('B');
            await until('the rebind', s, () => g.logs.some((l) => l.startsWith('supervisor: rebound to claim 2')));
            let answer = await gateRunOf(g, { exec: 'echo hi' });
            for (let tries = 0; answer.status === 503 && tries < 200; tries++) {
                await nap(20);
                answer = await gateRunOf(g, { exec: 'echo hi' });
            }
            expect(answer.status).toBe(200);
            expect(JSON.parse(answer.body)).toEqual({ exitCode: 0, output: 'ran on driver B' });
            expect(s.gateRuns).toEqual([{ driver: 'B', command: 'echo hi' }]);
            s.agentExits(g, 0);
            await settled(s);
        } finally {
            await s.teardown();
        }
    }, 40_000);

    // A run with no gate environment (a repository with none, or a `gates: false` workflow node) answers exec "no gates".
    it('a job with no gate environment answers its agent\'s exec "no gates"', async () => {
        const s = new Sim(scaled(15));
        try {
            s.release();
            await s.start('A');
            await until('the agent released', s, () => Boolean(released(s)));
            const g = firstGroup(s);
            const answer = await gateRunOf(g, { exec: 'echo hi' });
            expect(answer.status).toBe(404);
            expect(JSON.parse(answer.body)).toEqual({ error: 'no gates' });
            expect(s.gateRuns).toEqual([]);
            s.agentExits(g, 0);
            await settled(s);
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

/*
 * The adopted agent's GitHub credential call across a takeover: the real broker and `board-call.cjs`, the real
 * `attempt-pair.cjs` over the group's agent relay, and the board's credential route as the Sim answers it (a held
 * lease on an unended row is 503 LEASE_PENDING). Kubernetes delivers the new lease with the binding Secret's refresh;
 * docker writes it into the group at once.
 *
 * Production numbers, compressed: the window (120 s) is derived from the observed Secret delivery (60-90 s, taken as
 * 75 s) and the base budget is 30 s; both are scaled by the factor that maps 75 s to the timing's `refreshMs`, and so
 * are the helper's sleeps (its Retry-After and backoff). The relations are what the case pins: the delivery outlasts
 * the base and fits the window.
 */
const requireRunner = createRequire(import.meta.url);
type BrokerResult = { ok: boolean; token?: string; reason?: string };
const credentialBroker = requireRunner(join(REPO_ROOT, 'docker/executor-common/credential-broker.cjs')) as {
    obtain: (deps: unknown, key: string) => Promise<BrokerResult>;
    defaultDeps: (env: Record<string, string>) => Record<string, unknown>;
    GITHUB_KEY: string;
};
const { createBudget } = requireRunner(join(REPO_ROOT, 'docker/executor-common/board-call.cjs')) as {
    createBudget: (options: { now: () => number; baseMs: number; pendingWindowMs?: number }) => unknown;
};
const OBSERVED_DELIVERY_MS = 75_000;
const BASE_MS = 30_000;
const WINDOW_MS = 120_000;
/** The kind lane's timing with a refresh longer than the grace (a row of the matrix above). */
const DELIVERY: Timing = { ...scaled(15), refreshMs: 2 * scaled(15).rebindGraceMs };
const rebound = (g: Group) => g.logs.some((l) => l.startsWith('supervisor: rebound to claim 2'));

/** One `github-credential.cjs`-shaped call from inside group `g`, started now. */
function credentialCall(s: Sim, g: Group, t: Timing) {
    const by = t.refreshMs / OBSERVED_DELIVERY_MS;
    // Whole milliseconds: a timer or an abort signal takes no fraction.
    const baseMs = Math.round(BASE_MS * by);
    const windowMs = Math.round(WINDOW_MS * by);
    const delivery = t.refreshMs + t.controlMs;
    if (delivery >= windowMs || delivery <= baseMs) {
        throw new Error(
            `the delivery (${delivery} ms) must outlast the base (${baseMs}) and fit the window (${windowMs})`
        );
    }
    const tries: { lease: string; status: number }[] = [];
    const stderr: string[] = [];
    const env = {
        RUNNER_JOB_ID: s.row.id,
        RUNNER_LEASE_TOKEN: g.lease,
        FACTORY_STATS_URL: 'http://board.test',
        FACTORY_CONTROL_SOCKET: join(g.root, 'out', AGENT_MAILBOX_DIR, MAILBOX_FILES.relay),
    };
    const deps = {
        ...credentialBroker.defaultDeps(env),
        dir: join(mkdtempSync(join(tmpdir(), 'takeover-credentials-')), 'cache'),
        fetch: async (url: string, init: RequestInit) => {
            const headers = init.headers as Record<string, string>;
            const lease = headers['x-factory-job-lease-token'] ?? '';
            const answer = s.credentialAnswer(new URL(url).pathname.split('/')[3] ?? '', lease);
            tries.push({ lease, status: answer.status });
            return answer;
        },
        sleep: (ms: number) => nap(Math.round(ms * by)),
        stderr: (line: string) => stderr.push(line),
        budget: createBudget({ now: Date.now, baseMs, pendingWindowMs: windowMs }),
    };
    const started = Date.now();
    const done = credentialBroker
        .obtain(deps, credentialBroker.GITHUB_KEY)
        .then((result) => ({ result, elapsed: Date.now() - started }));
    return { done, tries, stderr, baseMs, windowMs };
}

describe('takeover simulation, the adopted agent asks for its GitHub credential', () => {
    it("kubernetes: the adopted agent's GitHub credential call made before the Secret refresh succeeds once the binding arrives", async () => {
        const s = new Sim(DELIVERY);
        try {
            s.release();
            const a = await s.start('A');
            await until('the agent released', s, () => Boolean(released(s)));
            const g = firstGroup(s);
            await s.kill(a);
            s.expireLease();
            await s.start('B');
            await until('claim 2', s, () => s.claimSeqs.length === 2);
            expect(rebound(g)).toBe(false);
            const call = credentialCall(s, g, DELIVERY);
            const { result, elapsed } = await call.done;
            expect(result, `${call.stderr.join('\n')}\n${s.text()}`).toMatchObject({
                ok: true,
                token: `ghs_for_${s.row.leaseToken}`,
            });
            expect(rebound(g)).toBe(true);
            expect(elapsed).toBeGreaterThan(call.baseMs);
            expect(call.tries.some((t) => t.lease === g.lease && t.status === 503)).toBe(true);
            expect(call.tries.at(-1)).toEqual({ lease: s.row.leaseToken, status: 200 });
            s.agentExits(g, 0);
            await settled(s);
        } finally {
            await s.teardown();
        }
    }, 60_000);

    it('kubernetes: a drained hand-back, re-claimed, then the credential call', async () => {
        const s = new Sim(DELIVERY);
        try {
            s.release();
            const a = await s.start('A');
            await until('the agent released', s, () => Boolean(released(s)));
            const g = firstGroup(s);
            await a.loop.handover('the driver is draining');
            await s.kill(a);
            expect(s.row.status).toBe('queued');
            // The hand-back gave A's lease up while its agent runs on: the call starts before any claim.
            const call = credentialCall(s, g, DELIVERY);
            await s.start('B');
            const { result } = await call.done;
            expect(result, `${call.stderr.join('\n')}\n${s.text()}`).toMatchObject({
                ok: true,
                token: `ghs_for_${s.row.leaseToken}`,
            });
            expect(call.tries[0]).toEqual({ lease: g.lease, status: 503 });
            s.agentExits(g, 0);
            await settled(s);
        } finally {
            await s.teardown();
        }
    }, 60_000);

    // Counterpart pin, green before the fix: docker writes the binding at once, so the new lease reaches the agent in
    // one control poll, inside the base budget.
    it("docker: the adopted agent's credential call succeeds on the direct binding write", async () => {
        const s = new Sim(DELIVERY, { executor: 'docker' });
        try {
            s.release();
            const a = await s.start('A');
            await until('the agent released', s, () => Boolean(released(s)));
            const g = firstGroup(s);
            await s.kill(a);
            s.expireLease();
            await s.start('B');
            await until('claim 2', s, () => s.claimSeqs.length === 2);
            const call = credentialCall(s, g, DELIVERY);
            const { result, elapsed } = await call.done;
            expect(result, `${call.stderr.join('\n')}\n${s.text()}`).toMatchObject({
                ok: true,
                token: `ghs_for_${s.row.leaseToken}`,
            });
            expect(elapsed).toBeLessThan(call.baseMs);
            s.agentExits(g, 0);
            await settled(s);
        } finally {
            await s.teardown();
        }
    }, 60_000);

    it('kubernetes: the call ends pending, not refused, when the binding never arrives', async () => {
        const s = new Sim(DELIVERY);
        s.deliverBindings = false;
        try {
            s.release();
            const a = await s.start('A');
            await until('the agent released', s, () => Boolean(released(s)));
            const g = firstGroup(s);
            await s.kill(a);
            s.expireLease();
            await s.start('B');
            await until('claim 2', s, () => s.claimSeqs.length === 2);
            const call = credentialCall(s, g, DELIVERY);
            const { result, elapsed } = await call.done;
            expect(result).toEqual({ ok: false, reason: 'pending' });
            expect(call.stderr.join('\n')).toContain('Retry the step shortly');
            expect(elapsed).toBeGreaterThan(call.baseMs);
            // One request or pair read past the window at most: each is clamped to what was left.
            expect(elapsed).toBeLessThanOrEqual(call.windowMs + 1000);
            expect(call.tries.every((t) => t.status === 503)).toBe(true);
        } finally {
            await s.teardown();
        }
    }, 60_000);
});
