/**
 * A compressed world for driver loss, takeover and adoption (#829). Real: the claim loop, the gate
 * server and step broker (the supervisor's control endpoint), `supervisor.cjs` and the binding it
 * follows, `settleEnd`'s callers, the takeover and adoption decisions of `loop-adopt.ts`. Played:
 * the board (`server/src/db/job-store-claim.ts` semantics, copied as shapes: a claim of an expired
 * lease records the interruption and moves the claim sequence; a heartbeat or complete under the
 * current token holds; a staged conclusion of an expired lease commits), the cluster (a group is a
 * supervisor in this process; its binding Secret reaches the mounted file `refreshMs` after a
 * rebind, as the kubelet's refresh does), and the agent (a file in the group's mailbox).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Board, BoardJob } from '../../src/board.js';
import { createGateServer, createSupervisedGateManager } from '../../src/gates.js';
import { createLoop, type Loop } from '../../src/loop.js';
import { type AdoptedRun, type LiveRun, ownGroup, type Runner } from '../../src/runner.js';
import { createStepBroker } from '../../src/step-control.js';
import { orderFinish, orderGo, stepHostOf, stepRequest, submitStep } from '../../src/supervised-steps.js';
import {
    AGENT_MAILBOX_DIR,
    finalReportOf,
    MAILBOX_FILES,
    MAILBOXES,
    SUPERVISOR_ENV,
    SUPERVISOR_RELEASED_LINE,
    SUPERVISOR_SERVED_LINE,
} from '../../src/supervisor-contract.js';
import { reportFinalized } from '../../src/termination.js';
import { bindingBody, supervisorLiterals } from '../../src/supervisor-plan.js';
import { config as baseConfig, job as baseJob, ok, stubBoard, stubRunner } from './loop-stubs.js';

process.env.SUPERVISOR_NO_MAIN = '1';
const supervisor = createRequire(import.meta.url)('../../src/scripts/supervisor.cjs') as {
    supervise(env: Record<string, string>, log: (line: string) => void): Promise<number>;
};

export interface Timing {
    leaseSeconds: number;
    rebindGraceMs: number;
    /** The kubelet's Secret refresh into the mounted binding file (2 x its sync period). */
    refreshMs: number;
    /** The supervisor's orphan bound before release (the production floor, scaled). */
    orphanMs: number;
    /** The supervisor's poll of its driver (`RUN_CONTROL_POLL_MS`, scaled). */
    controlMs: number;
    /** The driver's claim poll. */
    pollMs: number;
}

/** The kind lane's timing (lease 45, grace 20, sync 5) divided by `by`; the lease stays whole seconds. */
export const scaled = (by: number): Timing => ({
    leaseSeconds: Math.max(1, Math.round(45 / by)),
    rebindGraceMs: Math.round(20_000 / by),
    refreshMs: Math.round(10_000 / by),
    orphanMs: Math.round(30_000 / by),
    controlMs: Math.round(5_000 / by),
    pollMs: Math.round(5_000 / by),
});

export const TOOK_OVER = 'took over the running agent of claim 1, whose driver was lost';
export const ADOPTED = 'adopted the finished runner of claim 1, whose driver was lost';

const never = new Promise<never>(() => {});
export const nap = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Group {
    lease: string;
    claimSeq: number;
    root: string;
    file: string;
    logs: string[];
    exit: number | null;
    done: Promise<number>;
    secretWrites: number;
}

interface Row {
    id: string;
    status: 'queued' | 'running' | 'succeeded' | 'dead';
    claimSeq: number;
    leaseToken: string | null;
    leaseExpiresAt: number;
    interruptions: { claimSeq: number; reason: string }[];
    staged: { lease: string; result: unknown } | null;
    checkpoints: { runClaimSeq: number; phase: string; tree: string | null; result: unknown }[];
    output: string;
}

export class Driver {
    dead = false;
    loop!: Loop;
    server?: ReturnType<typeof createGateServer>;
    constructor(
        readonly name: string,
        readonly steps = createStepBroker()
    ) {}
}

export class Sim {
    readonly dirs: string[] = [];
    readonly logs: string[] = [];
    readonly groups = new Map<string, Group>();
    readonly row: Row;
    readonly config;
    readonly drivers: Driver[] = [];
    /** What the publish step of a group waits on: a file the test touches. */
    readonly latch: string;
    /** Held until the test opens it: the attempt has a group but no `go` yet (the setup is running). */
    goGate: Promise<void> = Promise.resolve();
    sweptAt: { exit: number | null }[] = [];
    spawned = 0;
    agentRuns = 0;
    publishes = 0;

    constructor(readonly t: Timing) {
        this.config = {
            ...baseConfig(),
            leaseSeconds: t.leaseSeconds,
            rebindGraceMs: t.rebindGraceMs,
            pollMs: t.pollMs,
        };
        const dir = mkdtempSync(join(tmpdir(), 'takeover-sim-'));
        this.dirs.push(dir);
        this.latch = join(dir, 'publish.go');
        this.row = {
            id: baseJob(1).id,
            status: 'queued',
            claimSeq: 0,
            leaseToken: null,
            leaseExpiresAt: 0,
            interruptions: [],
            staged: null,
            checkpoints: [],
            output: '',
        };
    }

    log = (who: string) => (m: string) => this.logs.push(`[${who}] ${m}`);
    text = () => this.logs.join('\n');

    /** `expire_claim_one`: the live lease of the current claim is expired at once. */
    expireLease = () => {
        this.row.leaseExpiresAt = Date.now() - 1000;
    };
    release = () => writeFileSync(this.latch, 'go');
    pubRuns = () => (existsSync(`${this.latch}.runs`) ? readFileSync(`${this.latch}.runs`, 'utf8').length / 2 : 0);
    brief = () => `${this.row.status}|${this.row.interruptions.length}|${this.row.interruptions[0]?.claimSeq ?? ''}`;

    // ---- the board ----

    private take(): BoardJob {
        const r = this.row;
        r.claimSeq += 1;
        r.status = 'running';
        r.leaseToken = randomUUID();
        r.leaseExpiresAt = Date.now() + this.t.leaseSeconds * 1000;
        const continues = r.interruptions.at(-1)?.claimSeq === r.claimSeq - 1;
        return {
            ...baseJob(1),
            id: r.id,
            claimSeq: r.claimSeq,
            leaseToken: r.leaseToken,
            leaseExpiresAt: new Date(r.leaseExpiresAt).toISOString(),
            continuesInterrupted: continues,
        };
    }

    private readonly holds = (claimed: BoardJob) =>
        this.row.status === 'running' && this.row.leaseToken === claimed.leaseToken;

    private boardImpl(): Partial<Board> {
        const r = this.row;
        const hold = (claimed: BoardJob) => (this.holds(claimed) ? ('held' as const) : ('lost' as const));
        return {
            claim: async () => {
                if (r.status === 'queued') return this.take();
                if (r.status !== 'running' || r.leaseExpiresAt > Date.now()) return null;
                if (r.staged && r.staged.lease === r.leaseToken) {
                    r.interruptions.push({ claimSeq: r.claimSeq, reason: 'the driver was lost after staging' });
                    r.status = 'succeeded';
                    return null;
                }
                r.interruptions.push({ claimSeq: r.claimSeq, reason: 'lease expired' });
                return this.take();
            },
            heartbeat: async (claimed) => {
                if (!this.holds(claimed)) return 'lost';
                r.leaseExpiresAt = Date.now() + this.t.leaseSeconds * 1000;
                return { result: 'held', cancelRequested: false };
            },
            progress: async (claimed) => hold(claimed),
            session: async (claimed) => hold(claimed),
            gates: async (claimed) => hold(claimed),
            interrupt: async (claimed, interruption) => {
                if (!this.holds(claimed)) return 'lost';
                // An adopted earlier attempt is recorded once (the claim that superseded it already did).
                const seq = interruption.claimSeq ?? claimed.claimSeq;
                if (!r.interruptions.some((i) => i.claimSeq === seq))
                    r.interruptions.push({ claimSeq: seq, reason: interruption.reason });
                if (interruption.release) r.status = 'queued';
                return 'held';
            },
            stageConclusion: async (claimed, result) => {
                if (!this.holds(claimed)) return 'lost';
                r.staged = { lease: claimed.leaseToken, result };
                return 'held';
            },
            complete: async (claimed, result) => {
                if (!this.holds(claimed)) return { state: 'lost', reclaimId: null };
                r.status = 'succeeded';
                r.output = String((result as { output?: string }).output ?? '');
                return { state: 'held', reclaimId: null };
            },
            phaseCheckpoint: async (claimed, checkpoint) => {
                if (!this.holds(claimed)) return 'lost';
                r.checkpoints.push(structuredClone(checkpoint) as Row['checkpoints'][number]);
                return 'ok';
            },
            phaseCheckpoints: async (_claimed, runClaimSeq) =>
                r.checkpoints.filter((c) => c.runClaimSeq === runClaimSeq) as never,
        };
    }

    /** One driver's view of the board: a dead driver's calls never come back. */
    private boardFor(d: Driver): Board {
        const base = stubBoard([]).board;
        const impl = { ...base, ...this.boardImpl() } as unknown as Record<string, unknown>;
        return new Proxy(impl, {
            get: (target, key: string) => {
                const v = target[key];
                if (typeof v !== 'function') return v;
                return (...a: unknown[]) => {
                    if (d.dead) return never;
                    const out = (v as (...x: unknown[]) => unknown)(...a);
                    Promise.resolve(out).then(
                        (r) => this.logs.push(`<${d.name} board.${key} ${JSON.stringify(r)?.slice(0, 80)}>`),
                        () => undefined
                    );
                    return out;
                };
            },
        }) as unknown as Board;
    }

    // ---- the cluster ----

    groupOf(job: BoardJob): Group | undefined {
        return this.groups.get(ownGroup(job).leaseToken);
    }

    ensureGroup(job: BoardJob): Group {
        const have = this.groupOf(job);
        if (have) return have;
        const root = mkdtempSync(join(tmpdir(), 'takeover-group-'));
        this.dirs.push(root);
        for (const box of Object.values(MAILBOXES))
            mkdirSync(join(root, box.path.split('/').pop()!), { recursive: true });
        const file = join(root, 'binding.json');
        const logs: string[] = [];
        const env: Record<string, string> = {
            FACTORY_CTL_ROOT: root,
            SUPERVISOR_TICK_MS: '20',
            SUPERVISOR_AGENT_START_MS: '3600000',
            SUPERVISOR_AGENT_LOST_MS: '3600000',
            ...Object.fromEntries(supervisorLiterals(this.config, job, { exporting: false })),
            SUPERVISOR_BINDING_FILE: file,
            SUPERVISOR_ORPHAN_MS: String(this.t.orphanMs),
            SUPERVISOR_CONTROL_MS: String(this.t.controlMs),
            ...(job.supervisorEnv ?? {}),
        };
        const group: Group = {
            lease: job.leaseToken,
            claimSeq: job.claimSeq,
            root,
            file,
            logs,
            exit: null,
            done: never,
            secretWrites: 0,
        };
        group.done = supervisor.supervise(env, (line) => logs.push(line)).then((code) => (group.exit = code));
        this.groups.set(job.leaseToken, group);
        this.spawned += 1;
        return group;
    }

    /** `kubectl patch secret`: visible in the mounted file after the kubelet's refresh. */
    rebind(lease: string, body: string) {
        const group = this.groups.get(lease);
        if (!group) return;
        group.secretWrites += 1;
        setTimeout(() => writeFileSync(group.file, body), this.t.refreshMs);
    }

    /** The agent container ends on its own. */
    agentExits(group: Group, code = 0) {
        writeFileSync(join(group.root, 'out', AGENT_MAILBOX_DIR, MAILBOX_FILES.agentExit), `${code}\n`);
    }

    released = (g: Group) => g.logs.includes(SUPERVISOR_RELEASED_LINE);
    served = (g: Group) => g.logs.includes(SUPERVISOR_SERVED_LINE);

    /** The pod is gone: the supervisor stops answering anything. */
    deleteGroup(g: Group) {
        g.logs.push('POD DELETED');
        this.groups.delete(g.lease);
        this.deleted.push(g);
    }
    readonly deleted: Group[] = [];

    // ---- a driver ----

    runnerFor(d: Driver): Runner {
        const host = stepHostOf({ config: this.config, steps: d.steps });
        const sim = this;
        const base = stubRunner(async () => ok());
        const groupJob = (j: BoardJob) => ownGroup(j);
        return Object.assign(base, {
            async syncCheckout(job: BoardJob) {
                const created = !sim.groupOf(job);
                sim.ensureGroup(job);
                if (created) d.steps.attach(job.supervisorEnv?.[SUPERVISOR_ENV.controlToken] ?? '');
                return { ok: true, reason: null };
            },
            async run(job: BoardJob) {
                const group = sim.ensureGroup(job);
                const resumed = Boolean(job.groupLease);
                const token = job.supervisorEnv?.[SUPERVISOR_ENV.controlToken] ?? '';
                if (!resumed) {
                    await sim.goGate;
                    sim.agentRuns += 1;
                    await orderGo(host, job);
                }
                const report = await d.steps.awaitReport(token);
                return {
                    exitCode: report.agentExit ?? 1,
                    output: `agent of claim ${group.claimSeq}`,
                    timedOut: false,
                    started: true,
                };
            },
            async publishGit(job: BoardJob) {
                sim.publishes += 1;
                const own = sim.groupOf(job);
                // A group that is over serves nothing: the publish of an adopted run is a fresh group's, not played here.
                const result = {
                    ok: true,
                    published: true,
                    branch: 'b',
                    prUrl: 'https://example.test/pull/1',
                    reason: null,
                };
                if (!own || own.exit !== null) return result;
                const wait = `echo x >> ${sim.latch}.runs; while [ ! -e ${sim.latch} ]; do sleep 0.05; done`;
                await submitStep(
                    host,
                    job,
                    stepRequest(job, 'publish', { id: 'pr', argv: ['sh', '-c', wait], timeoutMs: 120_000 })
                );
                return result;
            },
            async adopt(job: BoardJob): Promise<AdoptedRun | LiveRun | null> {
                // The k8s `admitted`: the newest earlier group; a released group whose agent runs, or whose
                // supervisor still serves after the agent ended, is taken over; one waiting to end is waited out.
                const earlier = [...sim.groups.values()]
                    .filter((g) => g.claimSeq < job.claimSeq)
                    .sort((a, b) => b.claimSeq - a.claimSeq)[0];
                if (!earlier) return null;
                const prior: BoardJob = { ...job, claimSeq: earlier.claimSeq, leaseToken: earlier.lease };
                const live = (): LiveRun => ({
                    live: true,
                    prior,
                    claimSeq: earlier.claimSeq,
                    session: null,
                    startedAt: 'then',
                });
                const serving = earlier.exit === null && sim.released(earlier) && !sim.served(earlier);
                if (serving) return live();
                if (earlier.exit === null && !sim.released(earlier)) {
                    // Not released: skipped, and the fence sweeps it - the pod is deleted whatever its supervisor was doing.
                    sim.sweptAt.push({ exit: earlier.exit });
                    sim.deleteGroup(earlier);
                    return null;
                }
                if (earlier.exit === null) await earlier.done;
                const report = finalReportOf(earlier.logs.join('\n'));
                // An unlaunched or lost report finalized nothing: an infrastructure loss, given back to be redone.
                if (!reportFinalized(report)) return null;
                return {
                    outcome: ok({ exitCode: report.agentExit ?? 1, output: 'adopted' }),
                    claimSeq: earlier.claimSeq,
                };
            },
            async rebind(group: BoardJob, binding: Parameters<Runner['rebind']>[1]) {
                sim.rebind(groupJob(group).leaseToken, bindingBody(binding));
            },
            async finish(job: BoardJob) {
                await orderFinish(host, job).catch(() => undefined);
            },
            async kill(job: BoardJob) {
                const g = sim.groupOf(job);
                if (g) sim.deleteGroup(g);
            },
            abandon() {},
        }) as unknown as Runner;
    }

    async start(name: string): Promise<Driver> {
        const d = new Driver(name);
        const runner = this.runnerFor(d);
        const manager = createSupervisedGateManager({ config: this.config, runner });
        const server = createGateServer({ host: '127.0.0.1', manager, steps: d.steps });
        const gates = { manager, server, advertiseUrl: (port: number) => `http://127.0.0.1:${port}` };
        const log = this.log(name);
        d.loop = createLoop({ board: this.boardFor(d), runner, config: this.config, gates, log });
        this.drivers.push(d);
        d.server = server;
        void d.loop.start();
        return d;
    }

    /** The driver pod deleted with no drain: nothing answers, nothing is closed in order. */
    async kill(d: Driver, afterMs = 0) {
        // `afterMs` > 0: the pod object is gone but its process runs on until the kubelet kills it.
        if (afterMs > 0) await nap(afterMs);
        d.dead = true;
        await d.server?.close().catch(() => undefined);
    }

    async teardown() {
        for (const d of this.drivers) {
            d.dead = true;
            d.loop.stop();
            await d.server?.close().catch(() => undefined);
        }
        for (const dir of this.dirs) rmSync(dir, { recursive: true, force: true });
    }
}

export async function until(what: string, sim: Sim, ready: () => boolean, ms = 15_000): Promise<void> {
    const end = Date.now() + ms;
    while (!ready()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${sim.brief()}\n${sim.text()}`);
        await nap(20);
    }
}
