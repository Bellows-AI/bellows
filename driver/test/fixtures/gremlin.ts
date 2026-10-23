/**
 * Gremlins for the takeover simulation (#829, #922): a seeded plan of faults played at random points of
 * one run, and the invariants a run owes whatever hit it. Nothing here scripts an outcome: the plan says
 * what is injected and when, `check` says what must hold afterwards. A failing seed replays with
 * `GREMLIN_SEED=<n>`; `GREMLIN_RUNS` raises the count for a local soak.
 *
 * Injected: the runner pod evicted or deleted (the replacement too, while it is Pending, starting or
 * running), a node drain (cordon, then evict the pods it listed) on a cluster model with nodes, cordon
 * and a task volume pinned to one node, a hard driver kill, a driver drain's handover, and board
 * glitches (a call that throws or answers nothing, shorter than the lease: an inconclusive read).
 */
import { takeoverBoundMs } from '../../src/supervisor-plan.js';
import { type Group, nap, type Row, Sim, type Timing, until } from './takeover-sim.js';

/** mulberry32: small, seedable, the same stream on every platform. */
export function rng(seed: number) {
    let a = seed >>> 0;
    const next = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
        next,
        int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
        pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
        chance: (p: number) => next() < p,
    };
}
type Rng = ReturnType<typeof rng>;

/** The kind lane's timing divided far down, so a seed plays in a few seconds. */
export const GREMLIN_TIMING: Timing = {
    leaseSeconds: 3,
    rebindGraceMs: 800,
    refreshMs: 400,
    orphanMs: 1_200,
    controlMs: 200,
    pollMs: 150,
    tickMs: 100,
};

export type Fault =
    | { at: number; kind: 'evict' }
    | { at: number; kind: 'drain'; evictMs: number; takesMs: number; relist: boolean }
    | { at: number; kind: 'killDriver'; restartMs: number }
    | { at: number; kind: 'handover'; restartMs: number }
    | { at: number; kind: 'glitch'; ops: string[]; mode: 'throw' | 'timeout'; forMs: number };

export interface Plan {
    seed: number;
    timing: Timing;
    /** Where the task volume lives (kind's local-path: a pod can only resume on its node). */
    volumeNode: 'B' | 'C';
    /** The lane's choice: a drained node is schedulable again the moment its drain ends. */
    uncordonAfterDrain: boolean;
    /** How long a placed pod takes to bring its supervisor up. */
    podUpMs: number;
    /** How long an agent runs after the supervisor released it. */
    agentMs: number;
    /** When the publish latch opens. */
    publishAtMs: number;
    faults: Fault[];
    /** Host stall stand-in: the process busy-waits `ms` once, `afterMs` after the board hands out claim `claimSeq`. */
    hostStall?: { claimSeq: number; afterMs: number; ms: number };
    /** Product-bug stand-in, not a fault: the live lease lapses `afterMs` after claim `claimSeq`, with nothing in the host to blame. */
    leaseLapse?: { claimSeq: number; afterMs: number };
}

/** The loop watcher's tick, and the least lag it counts as a stall (a smaller one is scheduling noise). */
const STALL_TICK_MS = 25;
const STALL_MIN_MS = 30;

/** At most four infrastructure hits: the board's interruption budget is five. */
const MAX_HITS = 4;

export function planOf(seed: number, over: Partial<Plan> = {}): Plan {
    const r = rng(seed);
    const timing = { ...GREMLIN_TIMING, refreshMs: r.int(100, 1_400) };
    const faults: Fault[] = [];
    const count = r.int(1, MAX_HITS);
    let at = r.int(50, 700);
    for (let i = 0; i < count; i++) {
        const roll = r.next();
        if (roll < 0.34) faults.push({ at, kind: 'evict' });
        else if (roll < 0.62)
            faults.push({ at, kind: 'drain', evictMs: r.int(0, 200), takesMs: r.int(100, 1_500), relist: false });
        else if (roll < 0.8) faults.push({ at, kind: 'killDriver', restartMs: r.int(0, 1_800) });
        else if (roll < 0.9) faults.push({ at, kind: 'handover', restartMs: r.int(0, 1_200) });
        else {
            const ops = ['claim', 'heartbeat', 'phaseCheckpoints', 'progress'].filter(() => r.chance(0.6));
            faults.push({
                at,
                kind: 'glitch',
                ops: ops.length ? ops : ['heartbeat'],
                mode: r.pick(['throw', 'timeout']),
                forMs: r.int(100, 800),
            });
        }
        // The next fault lands anywhere: before the replacement exists, while it starts, once it runs.
        at += r.int(0, 1_600);
    }
    return {
        seed,
        timing,
        volumeNode: r.pick(['B', 'C'] as const),
        uncordonAfterDrain: r.chance(0.75),
        podUpMs: r.int(0, 700),
        agentMs: r.int(100, 800),
        publishAtMs: r.int(0, 2_000),
        faults,
        ...over,
    };
}

/** Nodes, cordons, a pinned task volume and a scheduler that leaves a pod Pending when nothing fits. */
export class Cluster {
    readonly cordoned = new Set<string>(['A']); // A carries the driver only
    readonly pending: Group[] = [];
    constructor(
        private readonly sim: Sim,
        private readonly volumeNode: string,
        private readonly podUpMs: number,
        private readonly trace: (m: string) => void
    ) {}

    place = (g: Group): string | null => {
        if (this.cordoned.has(this.volumeNode)) {
            this.pending.push(g);
            this.trace(`pod of claim ${g.claimSeq} Pending: ${this.volumeNode} is cordoned and holds the volume`);
            return null;
        }
        this.bind(g);
        return this.volumeNode;
    };

    private bind(g: Group) {
        g.node = this.volumeNode;
        this.trace(`pod of claim ${g.claimSeq} placed on ${g.node}`);
        setTimeout(() => g.start(), this.podUpMs);
    }

    cordon(node: string) {
        this.cordoned.add(node);
        this.trace(`cordon ${node}`);
    }

    uncordon(node: string) {
        this.cordoned.delete(node);
        this.trace(`uncordon ${node}`);
        for (const g of this.pending.splice(0)) {
            if (this.sim.groups.get(g.lease) === g) this.bind(g);
        }
    }

    podsOn(node: string): Group[] {
        return [...this.sim.groups.values()].filter((g) => g.node === node && g.exit === null);
    }
}

/** Holds the whole process, as a host that takes the CPU away does: no timer, socket or heartbeat runs meanwhile. */
function busyWait(ms: number) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        /* held on purpose */
    }
}

/** A stretch in which the event loop did not turn: `ms` long, ending at `at` (wall clock). */
export interface Stall {
    at: number;
    ms: number;
}

/**
 * The least stalled loop time that could explain a lost lease or orphan bound: a heartbeat is due every third of a
 * lease (every two seconds in setup), the supervisor answers a lost driver after the orphan bound less one poll, and
 * a released group waits one rebind grace for a newer holder. A lower bound on purpose: the ticker sees the loop,
 * not every turn of a heartbeat's call, so a stall near the margin is counted rather than judged.
 */
export const stallMarginMs = (t: Timing) =>
    Math.min((t.leaseSeconds * 1_000) / 3, t.orphanMs - t.controlMs, t.rebindGraceMs);

/** How much of the window `[from, to]` the loop spent stalled. */
export function stalledIn(stalls: readonly Stall[], from: number, to: number): number {
    return stalls.reduce((sum, s) => sum + Math.max(0, Math.min(s.at, to) - Math.max(s.at - s.ms, from)), 0);
}

/**
 * Whether the stalls inside an interruption's own silence (the lease's last renewal to its recording, a tick of slack
 * for a stall ending in the recording turn) reach the margin. Many slips of a few tens of milliseconds are scheduling
 * noise: one stall must also be a real share of the margin. A stall outside that silence explains nothing.
 */
export function stallExplains(stalls: readonly Stall[], i: { since: number; at: number }, margin: number) {
    const lost = stalledIn(stalls, i.since, i.at + STALL_TICK_MS);
    const worst = worstStallIn(stalls, i.since, i.at);
    return { lost, worst, explained: lost >= margin && worst >= margin / 4 };
}

/** The longest single stall in the window `[from, to]`. */
export const worstStallIn = (stalls: readonly Stall[], from: number, to: number) =>
    Math.max(0, ...stalls.filter((s) => s.at > from && s.at - s.ms < to).map((s) => s.ms));

export interface Verdict {
    seed: number;
    plan: Plan;
    trace: string[];
    violations: string[];
    /** Interruptions no fault hit that a host stall of at least the plan's margin explains: logged, not failed. */
    excused: string[];
}

/** One run: the plan played against the simulation, then the invariants. */
export async function runGremlin(seed: number, over: Partial<Plan> = {}): Promise<Verdict> {
    const plan = planOf(seed, over);
    const sim = new Sim(plan.timing);
    const t0 = Date.now();
    const trace: string[] = [];
    const say = (m: string) => trace.push(`${String(Date.now() - t0).padStart(5)}ms ${m}`);
    const cluster = new Cluster(sim, plan.volumeNode, plan.podUpMs, say);
    sim.place = cluster.place;
    const rr: Rng = rng(seed ^ 0x9e3779b9);

    /** Attempts a fault hit: claim sequences the board must have recorded, and ones it may have. */
    const required = new Set<number>();
    const allowed = new Set<number>();
    const liveGroup = () => [...sim.groups.values()].filter((g) => g.exit === null).at(-1);
    const drivers: Awaited<ReturnType<Sim['start']>>[] = [];
    let n = 0;
    let restarting = 0;
    const startDriver = async () => {
        const d = await sim.start(`D${n++}`);
        drivers.push(d);
        say(`driver ${d.name} up`);
    };

    const evict = (g: Group, why: string) => {
        const running = sim.row.status === 'running' && !sim.row.staged;
        // A pod over (its supervisor ended) loses nothing; a Pending one never ran an attempt but still a claim's. The
        // pod of an earlier claim is the row's claim's loss only once that claim holds it (a holder's token the driver
        // answered to): lost before that contact, the claim finds it over and redoes the group, which hit no attempt of it (#943).
        // `tokens` is insertion-ordered: index 0 is the owner's own token, the rest are holders' after a rebind.
        const holds =
            g.claimSeq === sim.row.claimSeq ||
            [...g.tokens].slice(1).some((t) => drivers.some((d) => d.steps.contacted(t)));
        if (running && g.exit === null) (holds ? required : allowed).add(sim.row.claimSeq);
        say(
            `${why}: pod of claim ${g.claimSeq} (node ${g.node ?? 'none'}) gone, row claim ${sim.row.claimSeq} ${sim.row.status}`
        );
        sim.deleteGroup(g);
    };

    const play = async (f: Fault) => {
        if (f.kind === 'evict') {
            const g = liveGroup();
            if (g) evict(g, 'evict');
            else say('evict: no pod');
        } else if (f.kind === 'drain') {
            const node = liveGroup()?.node ?? plan.volumeNode;
            cluster.cordon(node);
            const listed = cluster.podsOn(node);
            say(`drain ${node}: listed ${listed.length} pod(s)`);
            for (const g of listed) {
                await nap(f.evictMs);
                if (sim.groups.get(g.lease) === g) evict(g, 'drain');
            }
            await nap(f.takesMs);
            say(`drain ${node}: done`);
            if (plan.uncordonAfterDrain) cluster.uncordon(node);
            else setTimeout(() => cluster.uncordon(node), 2_000);
        } else if (f.kind === 'killDriver' || f.kind === 'handover') {
            const d = drivers.filter((x) => !x.dead).at(-1);
            if (!d) return;
            if (f.kind === 'handover') {
                say(`driver ${d.name} drains (handover) at row claim ${sim.row.claimSeq} ${sim.row.status}`);
                if (sim.row.status === 'running') allowed.add(sim.row.claimSeq);
                // A kill of this driver meanwhile (a host too loaded to space the faults) ends the wait: its calls never return.
                await Promise.race([d.loop.handover('the driver is draining'), d.killed]);
                if (d.dead) return;
            } else if (sim.row.status === 'running') {
                required.add(sim.row.claimSeq);
            }
            say(`driver ${d.name} killed at row claim ${sim.row.claimSeq} ${sim.row.status}`);
            await sim.kill(d);
            restarting += 1;
            setTimeout(() => {
                restarting -= 1;
                void startDriver();
            }, f.restartMs);
        } else {
            say(`board glitch ${f.mode} on ${f.ops.join(',')} for ${f.forMs}ms`);
            sim.boardFault = (op) => (f.ops.includes(op) ? (f.mode === 'throw' ? 0 : f.forMs) : undefined);
            await nap(f.forMs);
            delete sim.boardFault;
        }
    };

    // The agent of every released pod runs for a while and exits; the publish latch opens on its own clock.
    const agents = new Set<Group>();
    const agentWatch = setInterval(() => {
        for (const g of sim.groups.values()) {
            if (agents.has(g) || !sim.released(g)) continue;
            agents.add(g);
            setTimeout(() => {
                if (sim.groups.get(g.lease) === g) sim.agentExits(g, 0);
            }, plan.agentMs);
        }
    }, 20);
    // A host too loaded to turn the loop in time loses leases nobody injected: the stalls are kept so an interruption
    // no fault hit can be matched against the loop time lost in the silence before it.
    const stalls: Stall[] = [];
    let lastBeat = Date.now();
    const lagWatch = setInterval(() => {
        const now = Date.now();
        const lag = now - lastBeat - STALL_TICK_MS;
        if (lag >= STALL_MIN_MS) stalls.push({ at: now, ms: lag });
        lastBeat = now;
    }, STALL_TICK_MS);
    const latch = setTimeout(() => sim.release(), plan.publishAtMs);
    // Both are timed from a claim, not the run's start: a loaded host reaches the claim late, and the point is the lease.
    const afterClaim = (at: { claimSeq: number; afterMs: number } | undefined, act: () => void) => {
        if (!at) return;
        const watch = setInterval(() => {
            if (!sim.claimSeqs.includes(at.claimSeq)) return;
            clearInterval(watch);
            timers.push(setTimeout(act, at.afterMs));
        }, 10);
        return watch;
    };
    const timers: ReturnType<typeof setTimeout>[] = [];
    // After a stall the driver's overdue heartbeat can run before its overdue claim poll and renew the lease unseen;
    // the stall is repeated until the board has reclaimed, so what the run proves does not hang on that timer order.
    const stallUntilReclaimed = async (ms: number) => {
        for (let i = 0; i < 6 && sim.row.interruptions.length === 0; i++) {
            busyWait(ms);
            await nap(200);
        }
    };
    const watches = [
        afterClaim(plan.hostStall, () => void stallUntilReclaimed(plan.hostStall!.ms)),
        afterClaim(plan.leaseLapse, sim.expireLease),
    ];
    void rr;

    try {
        await startDriver();
        let last = Promise.resolve();
        for (const f of plan.faults) {
            const wait = f.at - (Date.now() - t0);
            if (wait > 0) await nap(wait);
            // A fault that takes time (a drain) runs on beside the next one.
            const p = play(f);
            last = last.then(() => p);
        }
        await last;
        delete sim.boardFault;
        sim.release();
        await until('a driver', sim, () => restarting === 0, 8_000);
        if (!drivers.some((d) => !d.dead)) await startDriver();
        await until(
            'the task to settle',
            sim,
            () => sim.row.status === 'succeeded',
            25_000 + takeoverBoundMs(sim.config)
        );
        // Pods over, after the verdict: every supervisor ends or is a pod already gone.
        await until(
            'no group left running',
            sim,
            () => [...sim.groups.values()].every((g) => g.exit !== null),
            8_000 + plan.timing.orphanMs
        );
    } catch (e) {
        trace.push(`run ended early: ${(e as Error).message.split('\n')[0]}`);
    } finally {
        clearInterval(agentWatch);
        clearInterval(lagWatch);
        clearTimeout(latch);
        for (const w of watches) clearInterval(w);
        for (const t of timers) clearTimeout(t);
    }

    // A heartbeat call that hangs for the glitch (its own cadence is a third of the lease, twice that in setup)
    // delays the next beat past what the lease leaves, so the board may rightly reclaim it.
    const blackout = plan.faults.some(
        (f) => f.kind === 'glitch' && f.mode === 'timeout' && f.ops.includes('heartbeat')
    );
    const margin = stallMarginMs(plan.timing);
    const excused: string[] = [];
    const explained = (i: Row['interruptions'][number]) => {
        if (blackout) {
            excused.push(`interruption of claim ${i.claimSeq} (${i.reason}): a heartbeat call hung in this plan`);
            return true;
        }
        // The silence before the board recorded it, and a tick of slack for the stall that ends in the recording turn.
        const from = i.since;
        const { lost, worst, explained: hostDid } = stallExplains(stalls, i, margin);
        if (!hostDid) {
            trace.push(
                `no host stall explains claim ${i.claimSeq}: ${lost}ms stalled in ${i.at - from}ms (worst ${worst}ms), margin ${margin}ms`
            );
            return false;
        }
        excused.push(
            `interruption of claim ${i.claimSeq} (${i.reason}): the loop stalled ${lost}ms in its silence, margin ${margin}ms`
        );
        return true;
    };
    const violations = check(sim, required, allowed, explained);
    if (excused.length) trace.push(...excused.map((m) => `host stall: ${m}`));
    const verdict: Verdict = {
        seed,
        plan,
        excused,
        trace: [
            ...trace,
            '--- driver and board',
            ...sim.logs.filter((l) => !l.startsWith('<') || /interrupt|complete/.test(l)),
            ...[...sim.groups.values(), ...sim.deleted].flatMap((g) => [
                `--- pod of claim ${g.claimSeq} (exit ${g.exit})`,
                ...g.logs.slice(-12),
            ]),
        ],
        violations,
    };
    await sim.teardown();
    return verdict;
}

/** What every run owes, whatever hit it. */
function check(
    sim: Sim,
    required: Set<number>,
    allowed: Set<number>,
    explained: (i: Row['interruptions'][number]) => boolean
): string[] {
    const bad: string[] = [];
    const row = sim.row;
    const recorded = row.interruptions.map((i) => i.claimSeq);
    if (row.status !== 'succeeded') bad.push(`the task ended ${row.status}, not succeeded`);
    for (const c of required)
        if (!recorded.includes(c)) bad.push(`claim ${c} was hit by a fault but no interruption was recorded for it`);
    for (const i of row.interruptions)
        if (!required.has(i.claimSeq) && !allowed.has(i.claimSeq) && !explained(i))
            bad.push(`interruption of claim ${i.claimSeq} that no injected fault hit`);
    if (new Set(recorded).size !== recorded.length) bad.push(`an attempt interrupted twice: ${recorded.join(',')}`);
    if (sim.claimSeqs.some((c, i) => c !== i + 1))
        bad.push(`claim sequence not strictly increasing: ${sim.claimSeqs.join(',')}`);
    // A publish whose attempt was then interrupted is redone by the next claim; one that stood is done once.
    const stood = sim.published.filter((c) => !recorded.includes(c));
    if (new Set(sim.published).size !== sim.published.length)
        bad.push(`an attempt published twice: ${sim.published.join(',')}`);
    if (stood.length > 1)
        bad.push(`published by ${stood.length} attempts that were not interrupted: ${stood.join(',')}`);
    for (const g of sim.groups.values())
        if (g.exit === null) bad.push(`a group of claim ${g.claimSeq} is left running`);
    // An unconfirmed read is no verdict: the driver ended an attempt only once the board no longer held it.
    for (const k of sim.driverKills)
        if (k.held && k.unexpired) bad.push(`the driver killed claim ${k.claimSeq} that still held its lease`);
    return bad;
}
