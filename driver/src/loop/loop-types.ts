import type { PhaseChain } from './loop-phase-checkpoints.js';
import type { Board, BoardJob, LeaseState } from '../board/board.js';
import type { DriverConfig } from '../config.js';
import type { AdoptedRun, LiveRun, RunSession, Runner } from '../runner.js';
import type { GateManager, GateServer } from '../gates.js';
import type { JobState } from './loop-attempt.js';
import type { GateSession } from './loop-gates.js';

/**
 * The gate machinery, wired once at startup and handed to the loop only when it exists — an
 * operator who never asked for gates runs a loop that has never heard of them. The manager owns
 * the environment containers; the server owns the ad-hoc endpoint; the loop owns WHEN gates run,
 * because the loop is the only place that knows when the agent has finished talking.
 */
export interface GateStack {
    manager: GateManager;
    server: GateServer;
    /** Builds the URL the runner's agent is told to call, from the server's bound port. */
    advertiseUrl: (port: number) => string;
}

/**
 * Everything a running attempt needs from the loop that spawned it: the board and runner it talks
 * to, the driver's own config and (optional) gate machinery, its logger and sleeper, the reclaim
 * barrier and the per-clone queue every attempt's startup sync waits on, and the verdict-reporting entry point whose
 * worktree-reclaim side effect lives with the loop's other long-lived state.
 */
export interface LoopRuntime {
    board: Board;
    runner: Runner;
    config: DriverConfig;
    gates?: GateStack;
    /** Overrides `STOP_GRACE_MS` — a test seam, never set in production (issue #442). */
    stopGraceMs?: number;
    log: (message: string) => void;
    sleep: (ms: number) => Promise<void>;
    reclaims: Map<string, Promise<void>>;
    /**
     * Reports a verdict; a verdict-time worktree reclaim it orders waits for `after` — the
     * attempt's teardown (issue #821) — before it removes the tree.
     */
    report: (
        job: BoardJob,
        result: Parameters<Board['complete']>[1],
        options?: { after?: Promise<void> }
    ) => Promise<LeaseState>;
    /** The attempts in flight, by job id — what a drain hands over (`Loop.handover`, issue #792). */
    live?: Map<string, LiveAttempt>;
}

/** An attempt in flight: `over` settles when its `runJob` has ended and torn it down. */
export interface LiveAttempt {
    job: BoardJob;
    state: JobState;
    over: Promise<void>;
}

/**
 * Everything a setup step or the run phase needs about the one attempt it belongs to. Shared
 * between `loop-run.ts` and `loop-helpers.ts` (the block-helper steps, issue #207) rather than
 * defined in either — both need it, and neither should import runtime state from the other.
 */
export interface AttemptCtx {
    rt: LoopRuntime;
    job: BoardJob;
    state: JobState;
    /** Stops the heartbeat (issue #821); `end` (`loop-conclusion.ts`) is the only caller, once. */
    quiesce: () => Promise<void>;
    /** The attempt's one ending (`end`, `loop-conclusion.ts`): the first call decides, later calls await it. */
    ended?: Promise<LeaseState | null>;
    /** The gate session the attempt booted, released by `end`'s teardown; unset for a job with none. */
    gateSession?: GateSession;
    /** Set once the setup phase let the attempt through: from here `end` always releases its services. */
    setupDone?: true;
    /**
     * Whether this attempt holds the kubernetes checkout claim: taken by a successful sync, handed
     * to the runner at launch, and given back by `handBackFence` (`loop-fence.ts`) and by nothing
     * else — a refusal that ends an attempt no runner ever reached would otherwise hold the claim
     * for the life of the cluster (issue #469).
     */
    fenced: boolean;
    /** The task tree's fingerprint the startup sync answered; null when unknown. */
    treeBefore: string | null;
    /**
     * The session the attempt runs: the task group (issue #771) is created by the sync, before the
     * agent, and its agent container is specced for this session.
     */
    session: RunSession | null;
    /** Set once the services step started the attempt's declared services (`loop-services.ts`). */
    servicesStarted?: true;
    /** A services start the stand-down abandoned, settling late: `end` releases what it started unless the runner is retained. */
    abandonedServices?: Promise<void>;
    /**
     * The finished runner of an earlier claim this attempt adopted (issue #792): its outcome is the
     * run, so no sync, pre-helper or launch follows — the tree is the one that run left.
     */
    adopted?: AdoptedRun;
    /** The live run of an earlier claim this attempt took over (#829): no sync, setup or launch order follows. */
    takeover?: LiveRun;
    /** The post-run phase checkpoints (#829), opened by `verifyRun` before the gates and used by the phases after. */
    phases?: PhaseChain;
}

/** The completion body the board's `complete` takes: what a conclusion reports. */
export type VerdictBody = Parameters<Board['complete']>[1];

/**
 * A terminal conclusion of the setup phase, as data and never as acting. `runPhases`
 * (`loop-run.ts`) is the only thing that acts on one — the claim handed back, the attempt settled,
 * the line logged, the verdict reported — so a new refusal cannot forget any of it (issue #472,
 * step 3 of #433).
 *
 * - `fault` — a named failure, reported `failed`. The agent never runs.
 * - `leave` — infrastructure, not a verdict: the claim stays with its lease and the lease decides
 *   (a sync that threw).
 * - `interrupt` — a refusal this driver makes while alive (a services start the daemon or cluster
 *   refused, issue #822): handed back as an interruption carrying `reason` (`interruptDecision`),
 *   left to the lease only when that does not land. No verdict.
 * - `concluded` — the job really is done (a pre-run helper's `control: 'conclude'`, issue #230),
 *   reported `succeeded` with no agent, no gates, no post-helper and no publish.
 */
export type SetupHalt =
    | { halt: 'fault'; log: string; verdict: VerdictBody }
    | { halt: 'leave'; log: string }
    | { halt: 'interrupt'; reason: string }
    | { halt: 'concluded'; log: string; verdict: VerdictBody };

/**
 * What ends the setup phase: a stand-down the caller must stand down on, or a conclusion to land.
 * A step that is not done answers `null`.
 */
export type SetupConclusion = SetupHalt | typeof STOOD_DOWN;

/**
 * An earlier claim's attempt the adoption found and took over (issue #792): a durable record
 * `runPhases` performs for the step — an interruption `release: false`, under this claim's lease —
 * and no ending.
 */
export interface AdoptedRecord {
    record: 'interruption';
    reason: string;
    claimSeq: number;
}

/**
 * How one attempt ends, as data (issue #828): `end` (`loop-conclusion.ts`) lands the durable call
 * for it, then quiesces and tears down. A path decides; it never acts.
 *
 * - `verdict` — stage, then report (`log` said first, when there is one).
 * - `park` — a stopped attempt: the pump drained, `beforePark` run, then suspended.
 * - `interrupt` — handed back to the board as an interruption, released.
 * - `leave` — left to the lease; the runner of an attempt that launched stays for the next claim.
 * - `none` — the board has already moved on (a lost lease, a removed thread, a handover).
 */
export type EndDecision =
    | { kind: 'verdict'; verdict: VerdictBody; log?: string }
    | { kind: 'park'; phase: string; beforePark?: () => Promise<void> }
    | { kind: 'interrupt'; reason: string; exitCode: number | null }
    | { kind: 'leave'; log: string }
    | { kind: 'none'; log: string };

/** A setup step's answer that the attempt is down: `runPhases` (`loop-run.ts`) acts on it through `standDown`. */
export const STOOD_DOWN = 'stood-down' as const;
