/**
 * The claim loop's stub board, runner and gate stack, shared by `loop/` and the phase-boundary
 * fault harness (`loop-phase-faults.test.ts`): every call is recorded, every answer scripted.
 */
import type {
    ArtifactManifest,
    Board,
    BoardJob,
    HeartbeatVerdict,
    Interruption,
    LeaseState,
    QuestionVerdict,
    Reclaim,
    ReclaimRenewal,
    RequirementVerdict,
    ReviewClaim,
    RuntimeReport,
} from '../../src/board/board.js';
import type { GateRunRecord, GateRunWrite } from '../../src/board/board-gate-runs.js';
import type { PrOperationWrite } from '../../src/board/board-pr-operations.js';
import type { CheckpointPhase, PhaseCheckpoint } from '../../src/board/board-phase-checkpoints.js';
import { type DriverConfig, loadDriverConfig } from '../../src/config.js';
import type { ConnectionRelay } from '../../src/connection-control.js';
import type { CheckpointRelay, ExportRelay } from '../../src/export-control.js';
import type { ReviewControl } from '../../src/supervised-steps.js';
import type { GateManager, GateRun, GateRunOptions, GateServer } from '../../src/gates.js';
import type { HelperResult } from '../../src/helpers.js';
import { createLoop, type Loop } from '../../src/loop/loop.js';
import type { GateStack, LoopRuntime } from '../../src/loop/loop-types.js';
import type { PublishOptions, PublishResult, ReclaimResult, SyncResult, TreeProbe } from '../../src/publish/publish.js';
import type { PublishRelay } from '../../src/publish/publish-control.js';
import type { ControlEntry, QuestionRelay, QuestionResolution } from '../../src/question-control.js';
import { cancelPendingQuestions, hasPendingQuestion, newControl, resolveQuestion } from '../../src/question-control.js';
import type { ReviewRelay } from '../../src/review/review-control.js';
import type { SnapshotResult } from '../../src/review/review-snapshot.js';
import type {
    AdoptedRun,
    LiveRun,
    DeadService,
    Read,
    GateSizing,
    ReviewerSizing,
    RunOutcome,
    RunSession,
    Runner,
    RuntimeSample,
} from '../../src/runner.js';
import type { StepResult, SupervisorBinding } from '../../src/supervisor-contract.js';

export const USER = '44444444-4444-4444-8444-444444444444';

/** A fixed, valid Factory execution context — the shape master-prompt.test.ts pins; only its
 *  presence matters to this file's own tests, none of which assert its exact text. */
const MASTER_PROMPT =
    'Factory execution contract (factory-master-prompt/v1)\n\nFactory execution context\n- Mode: standalone';

export const job = (n: number, resumeSessionId: string | null = null): BoardJob => ({
    id: `0000000${n}-1111-4111-8111-111111111111`,
    command: `job ${n}`,
    rootCommand: `job ${n}`,
    attempts: 1,
    maxAttempts: 3,
    lastAttempt: false,
    claimSeq: 1,
    leaseToken: `0000000${n}-2222-4222-8222-222222222222`,
    leaseExpiresAt: '2026-08-29T12:05:00.000Z',
    executorType: 'claude-code',
    executorRefusal: null,
    planRefusal: null,
    skillRefusal: null,
    masterPrompt: MASTER_PROMPT,
    resumeSessionId,
    followUp: false,
    ownSession: false,
    continuesInterrupted: false,
    userId: USER,
    workspacePath: `bellows/${USER}`,
});

export interface BoardStub extends Board {
    completed: ({ id: string } & Parameters<Board['complete']>[1])[];
    /** Every phase checkpoint the loop wrote (issue #829), in write order. */
    phaseCheckpointsWritten: {
        id: string;
        leaseToken: string;
        runClaimSeq: number;
        phase: CheckpointPhase;
        tree: string | null;
        result: unknown;
    }[];
    /** The run claim sequence of every phase checkpoint read the loop made, with the job's lease token. */
    phaseCheckpointReads: { id: string; leaseToken: string; runClaimSeq: number }[];
    /** Every gate-run row the loop wrote (issue #983), in write order. */
    gateRunsWritten: GateRunWrite[];
    /** The run claim sequence of every gate-run read the loop made. */
    gateRunReads: { id: string; leaseToken: string; runClaimSeq: number }[];
    /** Every PR operation the loop recorded (issue #983), with the lease token it wrote under. */
    prOperationsWritten: { id: string; leaseToken: string; write: PrOperationWrite }[];
    /** The final envelopes the loop staged before each verdict (issue #821). */
    staged: ({ id: string } & Parameters<Board['complete']>[1])[];
    sessions: { id: string; sessionId: string | null }[];
    /** Whether each session report claimed post-launch evidence, in report order. */
    sessionEvidence: boolean[];
    progressed: { id: string; output: string; runtime: RuntimeReport | null }[];
    suspended: string[];
    /** The interrupted attempts the loop reported (issue #792). */
    interrupted: ({ id: string } & Interruption)[];
    /** Every runtime connection ask the loop relayed to the board (BEL-174), in order. */
    connectionAsks: { id: string; provider: string }[];
    beats: number;
    gatesReported: { id: string; results: Parameters<Board['gates']>[1] }[];
    /** Every GitHub credential ask the loop made, by job id (docs/connections.md). */
    githubAsks: string[];
    reclaimGrants: Reclaim[];
    reclaimAcks: string[];
    /** The token every ack rode under, in ack order (issue #821). */
    reclaimAckTokens: string[];
    /** Every reclaim renew the loop sent, with the token it rode under (issue #821). */
    reclaimRenewals: { id: string; token: string }[];
    /** Every question report the loop sent (issue #226) — ids only, never text. */
    questionsReported: string[];
    /** Every artifact chunk and manifest the loop sent, with the claim sequence each rode under. */
    artifactChunks: { id: string; claimSeq: number; stream: string; offset: number; text: string }[];
    artifactManifests: { id: string; claimSeq: number; stream: string; state: ArtifactManifest['state'] }[];
}

/**
 * Hands out the given jobs, then answers empty. After `idleBeforeStop` empty answers it stops the
 * loop — the loop is an infinite poll, so something has to end it, and counting idle polls is the
 * one signal that means "it has claimed everything it is going to".
 */
export function stubBoard(
    jobs: BoardJob[],
    options: {
        lease?: LeaseState;
        /** A lease that goes while the attempt runs: the first heartbeat after this answers true loses it. */
        leaseGone?: () => boolean;
        progressLease?: LeaseState;
        failProgress?: boolean;
        idleBeforeStop?: number;
        failClaims?: number;
        failSession?: boolean;
        reclaimId?: string | null;
        completeLease?: LeaseState;
        completeFor?: (claimed: BoardJob) => { state: LeaseState; reclaimId: string | null };
        cancelRequested?: boolean;
        removedOnBeat?: boolean;
        reclaims?: Reclaim[];
        ackReclaimLease?: 'ok' | 'lost' | 'missing';
        failAckReclaim?: boolean;
        /** Acks that throw before one lands — a response lost on the way back (issue #821). */
        failAckReclaimTimes?: number;
        /** The board's answer to a reclaim renew; held when absent (issue #821). */
        renewReclaim?: (id: string, token: string, signal?: AbortSignal) => Promise<ReclaimRenewal>;
        githubToken?: string | null;
        /** The board's answer to a question report (issue #226); held when absent. */
        questionVerdict?: QuestionVerdict;
        /** Every artifact call throws, as a board that is down does. */
        artifactsDown?: boolean;
        /** The board's answer to an interruption report (issue #792); held when absent. */
        interruptVerdict?: LeaseState | 'exhausted';
        /** The board's answer to a runtime connection ask (BEL-174); `waiting` when absent. */
        connectionVerdict?: RequirementVerdict | (() => Promise<RequirementVerdict>);
        /** Every heartbeat answers `requirementWait: true` (BEL-174): an adopter of an attempt that asked. */
        requirementWait?: boolean;
        /** The board's answer to a phase checkpoint read (issue #829); null (unreadable) when absent. */
        phaseCheckpoints?: PhaseCheckpoint[] | null | ((signal?: AbortSignal) => Promise<PhaseCheckpoint[] | null>);
        /** The board's answer to a phase checkpoint write (issue #829); `throw` models a board that throws. */
        phaseCheckpointWrite?: 'ok' | 'lost' | 'rejected' | 'throw';
        /** The board's answer to a gate-run read (issue #983); null (unreadable) when absent. */
        gateRuns?: GateRunRecord[] | null | ((signal?: AbortSignal) => Promise<GateRunRecord[] | null>);
        /** The board's answer to a gate-run write (issue #983). */
        gateRunWrite?: 'ok' | 'lost' | 'rejected' | 'throw';
        /** The board's answer to a PR-operation write (issue #983). */
        prOperation?: 'ok' | 'lost' | 'rejected' | 'throw';
        /** The board's answer to a staged conclusion (issue #821); held when absent. */
        stageAnswer?: Awaited<ReturnType<Board['stageConclusion']>>;
    } = {}
): { board: BoardStub; attach: (loop: Loop) => void } {
    let loop: Loop | null = null;
    let idle = 0;
    let failures = options.failClaims ?? 0;
    const queue = [...jobs];
    const reclaimQueue = options.reclaims ? [...options.reclaims] : [];
    let ackFailures = options.failAckReclaimTimes ?? 0;

    const board: BoardStub = {
        completed: [],
        staged: [],
        phaseCheckpointsWritten: [],
        phaseCheckpointReads: [],
        gateRunsWritten: [],
        gateRunReads: [],
        prOperationsWritten: [],
        sessions: [],
        sessionEvidence: [],
        progressed: [],
        suspended: [],
        interrupted: [],
        connectionAsks: [],
        beats: 0,
        gatesReported: [],
        githubAsks: [],
        reclaimGrants: [],
        reclaimAcks: [],
        reclaimAckTokens: [],
        reclaimRenewals: [],
        questionsReported: [],
        artifactChunks: [],
        artifactManifests: [],
        async checkpoint() {
            return { state: 'none' };
        },
        async checkpointChunk() {
            return null;
        },
        async transcripts() {
            return [];
        },
        async transcriptChunk() {
            return null;
        },
        async putArtifactChunk(claimed, ref, offset, bytes) {
            if (options.artifactsDown) throw new Error('board unreachable');
            const text = Buffer.from(bytes).toString('utf8');
            board.artifactChunks.push({ id: claimed.id, claimSeq: claimed.claimSeq, stream: ref.stream, offset, text });
            return { result: 'stored' };
        },
        async finalizeArtifact(claimed, ref, manifest) {
            if (options.artifactsDown) throw new Error('board unreachable');
            board.artifactManifests.push({
                id: claimed.id,
                claimSeq: claimed.claimSeq,
                stream: ref.stream,
                state: manifest.state,
            });
            return 'stored';
        },
        async question(_claimed, questionId) {
            board.questionsReported.push(questionId);
            return options.questionVerdict ?? 'held';
        },
        async leases() {
            return [];
        },
        async suspend(claimed) {
            board.suspended.push(claimed.id);
            return 'held';
        },
        async requireConnection(claimed, provider) {
            board.connectionAsks.push({ id: claimed.id, provider });
            const verdict = options.connectionVerdict ?? 'waiting';
            return typeof verdict === 'function' ? verdict() : verdict;
        },
        async interrupt(claimed, interruption) {
            board.interrupted.push({ id: claimed.id, ...interruption });
            return options.interruptVerdict ?? 'held';
        },
        async session(claimed, sessionId, observed = false) {
            if (options.failSession) throw new Error('board unreachable');
            board.sessions.push({ id: claimed.id, sessionId });
            board.sessionEvidence.push(observed);
            return 'held';
        },
        async progress(claimed, output, runtime) {
            if (options.failProgress) throw new Error('board unreachable');
            board.progressed.push({ id: claimed.id, output, runtime: runtime ?? null });
            return options.progressLease ?? 'held';
        },
        async claim() {
            if (failures > 0) {
                failures -= 1;
                throw new Error('board unreachable');
            }
            const next = queue.shift();
            if (next) return next;
            idle += 1;
            if (idle >= (options.idleBeforeStop ?? 1)) loop?.stop();
            return null;
        },
        async heartbeat() {
            board.beats += 1;
            if (options.lease === 'lost' || options.leaseGone?.()) return 'lost';
            if (options.removedOnBeat) return 'removed';
            const verdict: HeartbeatVerdict = {
                result: 'held',
                cancelRequested: options.cancelRequested ?? false,
                ...(options.requirementWait ? { requirementWait: true } : {}),
            };
            return verdict;
        },
        async claimReclaim(_worker) {
            const next = reclaimQueue.shift();
            if (next) board.reclaimGrants.push(next);
            return next ?? null;
        },
        async ackReclaim(id, token) {
            if (options.failAckReclaim) throw new Error('board unreachable');
            if (ackFailures > 0) {
                ackFailures -= 1;
                throw new Error('socket hang up');
            }
            board.reclaimAcks.push(id);
            board.reclaimAckTokens.push(token);
            return options.ackReclaimLease ?? 'ok';
        },
        async renewReclaim(id, token, signal) {
            board.reclaimRenewals.push({ id, token });
            return options.renewReclaim ? options.renewReclaim(id, token, signal) : 'held';
        },
        async githubCredential(claimed) {
            board.githubAsks.push(claimed.id);
            return options.githubToken ?? null;
        },
        async phaseCheckpoint(claimed, checkpoint) {
            board.phaseCheckpointsWritten.push({
                id: claimed.id,
                leaseToken: claimed.leaseToken,
                ...checkpoint,
                result: structuredClone(checkpoint.result),
            });
            if (options.phaseCheckpointWrite === 'throw') throw new Error('the board is down');
            return options.phaseCheckpointWrite ?? 'ok';
        },
        async phaseCheckpoints(claimed, runClaimSeq, signal) {
            board.phaseCheckpointReads.push({ id: claimed.id, leaseToken: claimed.leaseToken, runClaimSeq });
            const answer = options.phaseCheckpoints ?? null;
            return typeof answer === 'function' ? answer(signal) : answer;
        },
        async gateRun(_claimed, write) {
            board.gateRunsWritten.push(structuredClone(write));
            if (options.gateRunWrite === 'throw') throw new Error('the board is down');
            return options.gateRunWrite ?? 'ok';
        },
        async prOperation(claimed, write) {
            board.prOperationsWritten.push({
                id: claimed.id,
                leaseToken: claimed.leaseToken,
                write: structuredClone(write),
            });
            if (options.prOperation === 'throw') throw new Error('the board is down');
            return options.prOperation ?? 'ok';
        },
        async gateRuns(claimed, runClaimSeq, signal) {
            board.gateRunReads.push({ id: claimed.id, leaseToken: claimed.leaseToken, runClaimSeq });
            const answer = options.gateRuns ?? null;
            return typeof answer === 'function' ? answer(signal) : answer;
        },
        async stageConclusion(claimed, result) {
            board.staged.push({ id: claimed.id, ...result });
            return options.stageAnswer ?? 'held';
        },
        async complete(claimed, result) {
            board.completed.push({ id: claimed.id, ...result });
            if (options.completeFor) return options.completeFor(claimed);
            return { state: options.completeLease ?? 'held', reclaimId: options.reclaimId ?? null };
        },
        async gates(claimed, results) {
            board.gatesReported.push({ id: claimed.id, results });
            return options.lease ?? 'held';
        },
        async requestReview() {
            throw new Error('requestReview is not stubbed');
        },
        async readReview() {
            throw new Error('readReview is not stubbed');
        },
    };

    return { board, attach: (l) => (loop = l) };
}

export function stubRunner(
    outcome: (job: BoardJob, session: RunSession | null, onOutput?: (tail: string) => void) => Promise<RunOutcome>,
    options: {
        sample?: Omit<RuntimeSample, 'sampledAt'> | null;
        /** What the runner proves of the agent container's start; a normal run's default is proven. */
        agentStarted?: boolean;
        publish?: PublishResult | null;
        sync?: SyncResult | null;
        syncError?: Error;
        reclaim?: { ok: boolean; removed: boolean; reason: string | null } | null | undefined;
        /** Answers popped per reclaimWorktree call, falling back to `reclaim` (issue #344). */
        reclaimSequence?: ReclaimResult[];
        /** The post-gate tree probe's answer, recorded in `probed`; absent probes as unknown (null). */
        probeTree?: string | null | (() => string | null);
        /** The gate-run tree probes (issue #983); absent probes as unknown. */
        gateTree?: (sinceMs: number | null) => TreeProbe;
        /** The pre-gate no-change read (issue #1020); absent reads as a changed tree, a function may throw. */
        noChange?: boolean | (() => Promise<boolean>);
        /** The dead-service probe (issue #423); every call is counted in `deadServiceProbes`. */
        deadServices?: () => Promise<DeadService[]>;
        /** The pre-gate fleet restart (issue #560); every call is recorded in `restartedServices`. */
        restartServices?: (signal: AbortSignal) => Promise<void>;
        /** One review step's answer (issue #774); absent throws. */
        runReview?: (
            caller: BoardJob,
            review: ReviewClaim,
            session: RunSession | null,
            control: ReviewControl
        ) => Promise<StepResult>;
        /** A finished runner of an earlier claim to adopt (issue #792); absent finds none. */
        adopt?: (job: BoardJob, signal?: AbortSignal) => Promise<AdoptedRun | LiveRun | null>;
    } = {}
): Runner & {
    killed: string[];
    finished: string[];
    samples: number;
    published: BoardJob[];
    githubTokens: (string | undefined)[];
    /** The GitHub token each sync was handed. */
    syncTokens: (string | undefined)[];
    publishOptions: (PublishOptions | undefined)[];
    restartedServices: string[];
    synced: BoardJob[];
    reclaimed: BoardJob[];
    servicesReleased: string[];
    probed: BoardJob[];
    deadServiceProbes: number;
    startedServices: string[];
    /** The runtime budget pause/resume requests, by job id and paused state. */
    paused: { id: string; paused: boolean }[];
    /** Every gate resize the loop asked for (issue #773), in order. */
    resized: GateSizing[];
    /** Every reviewer resize (issue #774), in order. */
    reviewerResized: ReviewerSizing[];
    /** Every review the loop ran in a caller's group (issue #774). */
    reviewed: { caller: BoardJob; review: BoardJob; session: RunSession | null }[];
    /** Every holder binding the loop wrote to a group's supervisor (#829), in order. */
    rebound: { group: BoardJob; binding: SupervisorBinding }[];
    /** Every attempt the loop abandoned to the next holder. */
    abandoned: BoardJob[];
} {
    const { sample = null, publish = null, sync = null, syncError = null, reclaim = null } = options;
    const reclaimQueue = options.reclaimSequence ? [...options.reclaimSequence] : [];
    const runner = {
        servicesReleased: [] as string[],
        probed: [] as BoardJob[],
        deadServiceProbes: 0,
        async deadServices() {
            runner.deadServiceProbes += 1;
            return options.deadServices ? options.deadServices() : [];
        },
        async releaseServices(releasedJob: BoardJob) {
            runner.servicesReleased.push(releasedJob.id);
        },
        restartedServices: [] as string[],
        async restartServices(restartedJob: BoardJob, signal: AbortSignal) {
            runner.restartedServices.push(restartedJob.id);
            await options.restartServices?.(signal);
        },
        killed: [] as string[],
        finished: [] as string[],
        paused: [] as { id: string; paused: boolean }[],
        async pauseDeadline(pausedJob: BoardJob, paused: boolean) {
            runner.paused.push({ id: pausedJob.id, paused });
        },
        samples: 0,
        published: [] as BoardJob[],
        githubTokens: [] as (string | undefined)[],
        syncTokens: [] as (string | undefined)[],
        publishOptions: [] as (PublishOptions | undefined)[],
        synced: [] as BoardJob[],
        reclaimed: [] as BoardJob[],
        run: outcome,
        startedServices: [] as string[],
        async startServices(startedJob: BoardJob) {
            runner.startedServices.push(startedJob.id);
            return null;
        },
        async sampleRuntime() {
            runner.samples += 1;
            return sample;
        },
        async agentStarted() {
            return options.agentStarted ?? true;
        },
        async kill(killedJob: BoardJob) {
            runner.killed.push(killedJob.id);
        },
        async publishGit(publishedJob: BoardJob, githubToken?: string, publishOptions?: PublishOptions) {
            runner.published.push(publishedJob);
            runner.githubTokens.push(githubToken);
            runner.publishOptions.push(publishOptions);
            return (
                publish ?? {
                    ok: true,
                    published: false,
                    branch: null,
                    prUrl: null,
                    reason: null,
                    cause: null,
                    repository: null,
                    baseBranch: null,
                    prNumber: null,
                }
            );
        },
        async syncCheckout(
            syncedJob: BoardJob,
            _signal?: AbortSignal,
            _session?: RunSession | null,
            githubToken?: string
        ) {
            runner.synced.push(syncedJob);
            runner.syncTokens.push(githubToken);
            if (syncError) throw syncError;
            return sync ?? { ok: true, reason: null };
        },
        async reclaimWorktree(reclaimedJob: BoardJob) {
            runner.reclaimed.push(reclaimedJob);
            const next = reclaimQueue.shift();
            if (next) return next;
            return reclaim ?? { ok: true, removed: true, reason: null };
        },
        async probeTree(probedJob: BoardJob) {
            if (options.probeTree === undefined) return null;
            runner.probed.push(probedJob);
            return typeof options.probeTree === 'function' ? options.probeTree() : options.probeTree;
        },
        async probeGateTree(_probed: BoardJob, sinceMs: number | null) {
            return options.gateTree
                ? options.gateTree(sinceMs)
                : { fingerprint: null, content: null, mutatedSince: null };
        },
        async probeNoChange() {
            const { noChange } = options;
            return typeof noChange === 'function' ? noChange() : (noChange ?? false);
        },
        adopt: options.adopt ?? (async () => null),
        // A runner with no supervisor to stop through: the stop is the hard kill.
        stopAgent: (stoppedJob: BoardJob) => runner.kill(stoppedJob),
        async recordKill() {},
        async finish(finishedJob: BoardJob) {
            runner.finished.push(finishedJob.id);
        },
        async snapshotTree(): Promise<SnapshotResult> {
            return { ok: false, reason: 'no snapshot scripted' };
        },
        async runHelper(): Promise<HelperResult> {
            throw new Error('no helper scripted');
        },
        // The gate stack is stubbed whole in this suite; the runner's own gate step never runs here.
        async runGate(): Promise<StepResult> {
            throw new Error('no gate step scripted');
        },
        resized: [] as GateSizing[],
        async resizeGate(_job: BoardJob, phase: GateSizing) {
            runner.resized.push(phase);
            return true;
        },
        reviewerResized: [] as ReviewerSizing[],
        async resizeReviewer(_job: BoardJob, phase: ReviewerSizing) {
            runner.reviewerResized.push(phase);
            return false;
        },
        /** Every review the loop ran in a caller's group (issue #774), replaced by a test that scripts one. */
        reviewed: [] as { caller: BoardJob; review: BoardJob; session: RunSession | null }[],
        rebound: [] as { group: BoardJob; binding: SupervisorBinding }[],
        abandoned: [] as BoardJob[],
        abandon(abandonedJob: BoardJob): void {
            runner.abandoned.push(abandonedJob);
        },
        async rebind(group: BoardJob, binding: SupervisorBinding): Promise<void> {
            runner.rebound.push({ group, binding });
        },
        /** A prior group's supervisor is serving until a test scripts otherwise (#928). */
        async supervisorServing(): Promise<Read<boolean>> {
            return { kind: 'value', value: true };
        },
        async runReview(
            caller: BoardJob,
            review: ReviewClaim,
            session: RunSession | null,
            control: ReviewControl = {}
        ): Promise<StepResult> {
            runner.reviewed.push({ caller, review, session });
            if (!options.runReview) throw new Error('no review scripted');
            return options.runReview(caller, review, session, control);
        },
    };
    return runner;
}

export const ok = (over: Partial<RunOutcome> = {}): RunOutcome => ({
    exitCode: 0,
    output: 'done',
    timedOut: false,
    started: true,
    ...over,
});

/**
 * The runtime `runJob` and `adoptStep` take, without a claim loop around them: a verdict lands on
 * the board's `complete`, nothing reclaims.
 */
export function stubRuntime(board: BoardStub, runner: Runner, extra: Partial<LoopRuntime> = {}): LoopRuntime {
    return {
        board,
        runner,
        config: config(),
        log: () => {},
        sleep,
        reclaims: new Map(),
        report: async (reported, result) => (await board.complete(reported, result)).state,
        ...extra,
    };
}

export const config = (env: NodeJS.ProcessEnv = {}): DriverConfig => loadDriverConfig(env);

/**
 * Near-instant, so the suite never waits on a real poll interval or heartbeat period — but a
 * macrotask, not a resolved promise. An immediate `async () => {}` keeps the heartbeat spinning
 * inside the microtask queue, which starves every timer the fake runners are waiting on and hangs
 * the suite rather than failing it.
 */
export const sleep = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function drive(
    deps: {
        board: BoardStub;
        attach: (loop: Loop) => void;
        runner: Runner;
        gates?: GateStack;
        log?: (message: string) => void;
    },
    env = {}
) {
    const loop = createLoop({
        board: deps.board,
        runner: deps.runner,
        config: config(env),
        sleep,
        ...(deps.gates ? { gates: deps.gates } : {}),
        ...(deps.log ? { log: deps.log } : {}),
    });
    deps.attach(loop);
    await loop.start();
    return loop;
}

/**
 * A gate stack whose manager and server record what the loop asked of them. The manager answers
 * scripted exit codes; the server's listen answers a fixed port so the advertised URL is
 * predictable.
 */
export function stubGateStack(
    outcomes: Record<string, number> = {},
    options: {
        control?: boolean;
        polled?: boolean;
        setup?: GateRun | null;
        /** Called as each declared gate executes: a gate that edits the tree moves what the probe reads. */
        onRun?: (name: string) => void;
        /** The ad-hoc server's `quiesce`: settles once no ad-hoc run is in flight; immediate when absent. */
        quiesce?: (token: string) => Promise<void>;
    } = {}
) {
    const stack = {
        controlOpened: [] as string[],
        /** Each exporter token granted, beside the supervisor token it belongs to. */
        exportersGranted: [] as [string, string][],
        /** The review-bound exporter tokens open right now, by token (issue #774). */
        boundExporters: new Map<string, ExportRelay>(),
        stopsRaised: [] as string[],
        killsRaised: [] as string[],
        deadNotes: [] as [string, string | null][],
        controlClosed: [] as string[],
        controlDeparted: [] as { token: string; forMs: number }[],
        /** The real control state per open token (issue #226): questions run through the real code. */
        controls: new Map<string, ControlEntry>(),
        acquired: [] as string[],
        /** The env-file body each acquire was handed. */
        envBodies: [] as string[],
        released: [] as string[],
        registered: 0,
        /** Each token the gate server registered, in order. */
        registeredTokens: [] as string[],
        unregistered: 0,
        cancelled: [] as string[],
        /** Each token the gate server closed to ad-hoc runs, in order. */
        quiesced: [] as string[],
        advertised: '',
        ran: { key: '', names: [] as string[] },
        /** Every pre-agent `runSetup` call's options (issue #733), in order. */
        setups: [] as GateRunOptions[],
        manager: {
            acquire: async (key: string, _image: string, envBody: string) => {
                stack.acquired.push(key);
                stack.envBodies.push(envBody);
            },
            runSetup: async (_key: string, setupOptions: GateRunOptions = {}) => {
                stack.setups.push(setupOptions);
                return options.setup ?? null;
            },
            runGate: async (key: string, name: string) => {
                stack.ran = { key, names: [...stack.ran.names, name] };
                options.onRun?.(name);
                const code = outcomes[name] ?? 0;
                return { exitCode: code, output: code === 0 ? `${name} ok` : `${name} failed badly` };
            },
            release: (key: string) => {
                stack.released.push(key);
            },
            stop: async () => {},
        } as GateManager,
        server: {
            register: (token: string) => {
                stack.registered += 1;
                stack.registeredTokens.push(token);
            },
            unregister: () => {
                stack.unregistered += 1;
            },
            cancel: (token: string) => {
                stack.cancelled.push(token);
            },
            quiesce: async (token: string) => {
                stack.quiesced.push(token);
                await options.quiesce?.(token);
            },
            // The run-control channel (issue #442) is opt-in: a stack without it models a driver
            // whose endpoint could not open, where a Stop kills at once.
            openControl: (token: string, relay?: QuestionRelay, publisher?: PublishRelay, reviewer?: ReviewRelay) => {
                if (!options.control) throw new Error('no control endpoint in this stub');
                stack.controlOpened.push(token);
                stack.controls.set(token, newControl(relay ?? null, publisher ?? null, reviewer ?? null));
            },
            // The agent's own token opens the same entry's publish and review routes.
            grantAgent: (token: string, agentToken: string) => {
                const control = stack.controls.get(token);
                if (control) stack.controls.set(agentToken, control);
            },
            grantExporter: (token: string, exporterToken: string, exporter?: ExportRelay) => {
                if (exporter) stack.boundExporters.set(exporterToken, exporter);
                else stack.exportersGranted.push([token, exporterToken]);
            },
            revokeExporter: (exporterToken: string) => {
                stack.boundExporters.delete(exporterToken);
            },
            attachExporter: (token: string, exporter: ExportRelay) => {
                const control = stack.controls.get(token);
                if (control) control.exporting.relay = exporter;
            },
            attachCheckpoint: (token: string, checkpoint: CheckpointRelay) => {
                const control = stack.controls.get(token);
                if (control) control.checkpointing.relay = checkpoint;
            },
            attachConnection: (token: string, connection: ConnectionRelay) => {
                const control = stack.controls.get(token);
                if (control) control.connecting.relay = connection;
            },
            controlPolled: () => options.polled ?? true,
            raiseKill: (token: string) => {
                stack.killsRaised.push(token);
                const control = stack.controls.get(token);
                if (control) control.kill = true;
            },
            raiseStop: (token: string) => {
                stack.stopsRaised.push(token);
                const control = stack.controls.get(token);
                if (control) control.stop = true;
            },
            closeControl: (token: string) => {
                stack.controlClosed.push(token);
                const control = stack.controls.get(token);
                for (const [key, entry] of stack.controls) if (entry === control) stack.controls.delete(key);
            },
            departControl: (token: string, forMs: number) => {
                stack.controlDeparted.push({ token, forMs });
                const control = stack.controls.get(token);
                for (const [key, entry] of stack.controls) if (entry === control) stack.controls.delete(key);
            },
            resolveQuestion: (token: string, id: string, resolution: QuestionResolution): boolean => {
                const control = stack.controls.get(token);
                return control ? resolveQuestion(control, id, resolution) : false;
            },
            hasPendingQuestion: (token: string): boolean => {
                const control = stack.controls.get(token);
                return control ? hasPendingQuestion(control) : false;
            },
            cancelQuestions: (token: string) => {
                const control = stack.controls.get(token);
                if (control) cancelPendingQuestions(control);
            },
            // No ad-hoc gate ran through this stub, so the timeout note's verdict history is empty.
            lastRuns: () => [],
            setDeadServices: (token: string, note: string | null) => {
                stack.deadNotes.push([token, note]);
            },
            listen: async () => 9099,
            close: async () => {},
        } as GateServer,
    };
    const gates: GateStack = {
        manager: stack.manager,
        server: stack.server,
        advertiseUrl: (port) => {
            stack.advertised = `http://host.docker.internal:${port}`;
            return stack.advertised;
        },
    };
    return { stack, gates };
}

export const gatedJob = (n: number): BoardJob => ({
    ...job(n),
    repo: 'Bellows-AI/factory',
    gates: {
        image: 'node:24',
        gates: [
            { name: 'test', command: 'npm test' },
            { name: 'lint', command: 'npm run lint' },
        ],
    },
});
