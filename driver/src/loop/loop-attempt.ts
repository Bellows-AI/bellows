import type { AnsweredQuestion, BoardJob, HeartbeatVerdict, RuntimeReport, ServiceStatus } from '../board/board.js';
import { deadServiceNote } from './loop-ledger.js';
import { currentActivity, DEAD_SERVICE_STATES, serviceHint } from '../runner.js';
import type { DeadService } from '../runner.js';
import type { RuntimeSample } from '../runner.js';
import { lostOf, recordEnding } from './loop-phase.js';
import type { AttemptPhase, AttemptTransition, Ending } from './loop-phase.js';
import type { LoopRuntime } from './loop-types.js';
import type { ExportRun } from './loop-export.js';
import type { PublishResult } from '../publish/publish.js';
import { RUN_CONTROL_POLL_MS } from '../supervisor-contract.js';
import { heartbeatPeriodMs } from '../supervisor-plan.js';
import type { KillRecord } from '../termination.js';
import type { TimeoutActivity } from '../timeout-note.js';

/** How often freshly arrived output is flushed to the board — the pace the dashboard polls at. */
const PROGRESS_MS = 2_000;
/**
 * The longest a park waits out a progress write in flight, by the wall clock: a board that never
 * answers it costs that tail, never the park (issue #773).
 */
const OUTPUT_DRAIN_MS = 5_000;
/** How often the drain looks again while a write is in flight. */
const OUTPUT_DRAIN_TICK_MS = 50;

/**
 * How often the heartbeat polls while the attempt is still SETTING UP — before the runner exists.
 * The run phase paces its beats at a third of the lease (100s at the default), which would leave a
 * Stop issued while the dashboard says "Waiting for the executor…" unobserved for a minute and a
 * half — through the whole checkout sync and gate-environment boot (issue #126). The setup phase
 * polls at this pace instead, so a stop there is answered — the attempt stands down without
 * spawning — within one period, and the row settles `stopped` right away.
 */
const SETUP_POLL_MS = 2_000;
/**
 * How often a launched attempt's heartbeat polls — and so how soon a Stop is seen — when that is
 * sooner than a lease third. Also the pace the task supervisor reads the control endpoint at
 * (handed to it as `SUPERVISOR_CONTROL_MS`). Not configurable (issue #442).
 */
export { RUN_CONTROL_POLL_MS };
/**
 * How long a draining attempt (a Stop raised on the control endpoint, the agent finishing its
 * current model step) gets before the hard kill lands. Not configurable (issue #442).
 */
export const STOP_GRACE_MS = 300_000;

/** One review being supervised: the order to cancel it, and its end (after the review row is settled and the reviewer released). */
export interface ReviewSupervision {
    cancel: () => void;
    settled: Promise<void>;
}

export interface JobState {
    /**
     * Stops the output pump's periodic writes and waits out the one in flight (issue #773): a park
     * lands the row terminal, and a write it overtook would be refused and its tail lost.
     */
    drainOutput: () => Promise<void>;
    /**
     * Where the attempt is, moved only through `transition` (`loop-phase.ts`). `concluding` is from
     * the moment it stages its verdict until it is torn down (issue #821): the heartbeat keeps
     * renewing the lease the verdict needs, and an ending recorded meanwhile acts on nothing — the
     * staged conclusion is the attempt's outcome, and the board commits it.
     */
    phase: AttemptPhase;
    /** Set the moment `end` starts concluding: a drain's handover leaves such an attempt to its own ending. */
    endStarted: boolean;
    /**
     * How the attempt ended where it stands, recorded once through `recordEnding`: a Stop (the
     * container is killed and the run settled on the board — the turn ends, and the session it kept
     * is what the follow-up continues, docs/jobs.md), a lost lease, a removed thread (nothing is
     * parked or reported: the tree belongs to the queue's reclaim) or a drain's handover (issue
     * #792: the board took the lease back as an interruption, so the attempt reads as lost, and the
     * runner is NEVER killed — the next claim adopts it). Null while none did.
     */
    ending: Ending | null;
    /** Writes the line of each `phase`/`ending` change; the loop points it at its log. */
    trace: (transition: AttemptTransition) => void;
    /**
     * True when the runner must outlive the attempt (issues #821, #828): neither the staged verdict
     * nor the complete, nor the park or interruption, reached the board, or the attempt is
     * left to its lease after its launch. `end`'s teardown then leaves the group and the checkout
     * claim for the next claim to adopt.
     */
    keepGroup: boolean;
    /**
     * True once `runner.run` has been called. The heartbeat paces itself at `SETUP_POLL_MS` until
     * this turns — a verdict arriving during the setup phase must be answered in seconds, not a
     * beat period — and at the lease's third afterwards (issue #126).
     */
    launched: boolean;
    /** The attempt's gate-endpoint token once its gate session booted — where the sampler tells the agent a service died. */
    gateToken: string | null;
    /**
     * Why an ad-hoc gate found the attempt's supervisor lost while the agent ran (issue #773): the
     * attempt is interrupted once its run is over, never given a verdict. Null while none did.
     */
    gateLoss: string | null;
    /**
     * The attempt's run-control token (`BELLOWS_CONTROL_TOKEN`), set once the control endpoint is
     * open for it; null until then, and for a driver with no endpoint at all.
     */
    control: string | null;
    /** The attempt's continuous transcript export (`loop-export.ts`); null for an executor with none. */
    transcriptExport: ExportRun | null;
    /**
     * True only while `runner.run` is in flight — the agent is working. A Stop is cooperative
     * only then; after the run (the gates, helpers, publish) there is no agent left to ask, and a
     * Stop stands the attempt down at once as it always did.
     */
    running: boolean;
    /**
     * True once a Stop was raised on the control endpoint: the agent finishes its current model
     * step and exits on its own, and the attempt settles as stopped when it does. Separate from
     * `stopped` and excluded from `down()` — the lease keeps renewing and the gates a draining
     * agent asked for keep running until the grace deadline or the exit.
     */
    draining: boolean;
    /** The grace deadline's timer while draining; cleared when the attempt settles. */
    graceTimer: ReturnType<typeof setTimeout> | null;
    /**
     * The reviews this attempt supervises, by key (issue #774): each runs in this attempt's task
     * group and ends with it. A key already here starts no second supervisor (`loop-review.ts`).
     */
    reviews: Map<string, ReviewSupervision>;
    /**
     * The review leases (`id:claimSeq`) this attempt has already ended (completed, failed or released):
     * a delayed answer carrying one starts nothing, a newer lease of the same review is supervised.
     */
    endedReviewLeases: Set<string>;
    /** Questions whose answers have not been delivered yet. */
    pendingQuestions: Set<string>;
    questionPausedAt: number | null;
    deadlineUpdate: Promise<void>;
    /** How far the run deadline has been pushed out by questions — what the timeout note adds to `jobTimeoutMs`. */
    deadlineExtensionMs: number;
    /** The last draft publication the agent made mid-run (`loop-publish.ts`); null when it made none. */
    draftPublication: PublishResult | null;
    /** Resolves the moment the run ends, so the heartbeat can stop waiting out its period. */
    woken: Promise<void>;
    wake: () => void;
    /**
     * Aborted the moment any verdict ends the attempt where it stands — stop, lost lease, Remove.
     * The one signal every slow step is raced against (`raceStep`) and the one handed to the
     * transports that take one (the docker checkout sync's client, the gates re-read, the helpers, the gate
     * environment's start, the gate exec, the tree probe), so a stand-down cancels in-flight work
     * instead of leaving each step its own controller (issues #472, #488). The publish is the one
     * slow call with no signal: a push cannot be recalled.
     */
    signal: AbortSignal;
    abortNow: () => void;
    /** Why the drain handed the attempt over; set with the `handover` ending, null otherwise. */
    handoverReason: string | null;
    /** Resolves when a `handover` ending wins (`handOver`, `loop.ts`): the run in flight is abandoned there. */
    handedOver: Promise<void>;
    signalHandover: () => void;
}

/**
 * The stop of one review the attempt supervises (issue #774): its own controller, so a refused
 * heartbeat on the review's row ends that review alone, aborted too when the attempt stands down.
 * Minted here beside the attempt's one signal, never in the supervision.
 */
export function newReviewStop(state: JobState): { stop: AbortController; release: () => void } {
    const stop = new AbortController();
    const standDown = (): void => stop.abort();
    if (state.signal.aborted) stop.abort();
    state.signal.addEventListener('abort', standDown, { once: true });
    return { stop, release: () => state.signal.removeEventListener('abort', standDown) };
}

export function newJobState(): JobState {
    let wake = () => {};
    const woken = new Promise<void>((resolve) => {
        wake = resolve;
    });
    const controller = new AbortController();
    let signalHandover = () => {};
    const handedOver = new Promise<void>((resolve) => {
        signalHandover = resolve;
    });
    return {
        drainOutput: async () => {},
        phase: 'setup',
        endStarted: false,
        ending: null,
        trace: () => {},
        keepGroup: false,
        launched: false,
        gateToken: null,
        gateLoss: null,
        control: null,
        transcriptExport: null,
        running: false,
        draining: false,
        graceTimer: null,
        reviews: new Map(),
        endedReviewLeases: new Set(),
        pendingQuestions: new Set(),
        questionPausedAt: null,
        deadlineUpdate: Promise.resolve(),
        deadlineExtensionMs: 0,
        draftPublication: null,
        woken,
        wake,
        signal: controller.signal,
        abortNow: () => controller.abort(),
        handoverReason: null,
        handedOver,
        signalHandover,
    };
}

/** Registers the attempt as in flight for a drain's handover; answers what to call once `runJob` is over. */
export function registerLive(rt: LoopRuntime, job: BoardJob, state: JobState): () => void {
    let over: () => void = () => {};
    rt.live?.set(job.id, {
        job,
        state,
        over: new Promise<void>((resolve) => {
            over = resolve;
        }),
    });
    return over;
}

/**
 * Ends the agent of a launched attempt now. With a control endpoint open, the supervised way: the
 * kill order is raised for the supervisor (it ends the agent, has the exporter drain what it wrote
 * and finalizes), and the runner waits, bounded, for the group to wind down before it falls back
 * to the hard kill. Without an endpoint, the hard kill. `kill`
 * is the reason the driver ends the run for, when it is a verdict of its own (`termination.ts`).
 */
export async function killAgent(
    rt: LoopRuntime,
    job: BoardJob,
    control: string | null,
    kill?: KillRecord
): Promise<void> {
    // Why the run ends, recorded first where a claim adopting it reads it back; a record that fails
    // never holds the kill back.
    if (kill) await rt.runner.recordKill(job, kill).catch(() => undefined);
    if (control !== null && rt.gates) {
        rt.gates.server.raiseKill(control);
        return rt.runner.stopAgent(job);
    }
    return rt.runner.kill(job);
}

/** The verdicts that end an attempt where it stands: a stop, a lost lease, a removed thread. */
export const down = (state: JobState): boolean => state.ending !== null;

/** Forget pending questions when the attempt ends or Stop cancels them. */
export function clearPendingQuestions(state: JobState): void {
    state.pendingQuestions.clear();
}

/** Serialize pause/resume with concurrent asks and heartbeat answers. */
export function updateQuestionDeadline(rt: LoopRuntime, job: BoardJob, state: JobState): Promise<void> {
    state.deadlineUpdate = state.deadlineUpdate
        .catch(() => {})
        .then(async () => {
            const paused = state.pendingQuestions.size > 0;
            if (state.phase === 'ended' || down(state) || (state.draining && paused)) return;
            if (paused === (state.questionPausedAt !== null)) return;
            await rt.runner.pauseDeadline(job, paused);
            if (paused) {
                state.questionPausedAt = Date.now();
            } else if (state.questionPausedAt !== null) {
                state.deadlineExtensionMs += Date.now() - state.questionPausedAt;
                state.questionPausedAt = null;
            }
        });
    return state.deadlineUpdate;
}

/** Deliver each answer once; resume the runtime budget only after the last answer. */
async function deliverAnswers(
    rt: LoopRuntime,
    job: BoardJob,
    state: JobState,
    answered: AnsweredQuestion[]
): Promise<void> {
    if (state.control === null) return;
    for (const { questionId, answers } of answered) {
        if (!rt.gates?.server.resolveQuestion(state.control, questionId, { state: 'answered', answers })) continue;
        state.pendingQuestions.delete(questionId);
    }
    await updateQuestionDeadline(rt, job, state);
}

/** A draining attempt whose run threw was being stopped all along: it stands down as stopped. */
export function stopIfDraining(state: JobState): void {
    if (state.draining) recordEnding(state, 'stop');
}

/** The loser side of every setup race: the stand-down resolved, the step did not. */
const RACE_LOST = Symbol('raceStep: the stand-down won');

/**
 * Races one slow setup step against the attempt's stand-down, so a Stop (or a lost lease, or a
 * Remove) observed while the driver is "waiting for the executor" ends the wait within a
 * heartbeat's setup poll instead of the step's own unbounded duration (issue #126). Answers null
 * when the stand-down won and the step is STILL RUNNING: the caller stands the attempt down and
 * the step is abandoned to its own cleanup — which is why a rejection is swallowed here, the
 * abandoned step's finally is the only cleanup it needs and its verdict is nobody's business
 * anymore. A step that finished first answers `{ value }` even when the stand-down landed in the
 * same instant — the caller's own flag check decides.
 */
export async function raceStep<T>(signal: AbortSignal, step: Promise<T>): Promise<{ value: T } | null> {
    // A side-band subscriber, so the loser of the race can never become an unhandled rejection:
    // subscribing neither consumes the step from the race nor changes its result. First, because
    // the check below abandons the step with nobody left to read it — and an abandoned step that
    // rejects must not take the driver with it.
    step.catch(() => {});
    // Already stood down: never even wait for the step, which is still running with nobody left
    // to read it.
    if (signal.aborted) return null;
    let onAbort: () => void = () => {};
    const lost = new Promise<typeof RACE_LOST>((resolve) => {
        onAbort = () => resolve(RACE_LOST);
        signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        const outcome: T | typeof RACE_LOST = await Promise.race([step, lost] as const);
        return outcome === RACE_LOST ? null : { value: outcome };
    } finally {
        // The attempt has as many steps as it has phases, and each subscribes: without this the
        // signal would keep every step that finished first alive until the attempt ends.
        signal.removeEventListener('abort', onAbort);
    }
}

/**
 * A Stop on a launched attempt: raised once on the control endpoint, with the grace deadline
 * armed. No kill — the agent finishes its current model step and exits, and the run's end settles
 * the attempt as stopped. Later stop beats retry a failed budget restoration. The grace deadline is the
 * hard kill for an agent that never gets to a boundary.
 */
async function startDraining(rt: LoopRuntime, job: BoardJob, state: JobState, control: string): Promise<void> {
    if (!state.draining) {
        state.draining = true;
        rt.gates?.server.raiseStop(control);
        // A pending question is cancelled with the stop, so the bridge interrupts the CLI even if it
        // never polled `/control`.
        rt.gates?.server.cancelQuestions(control);
        clearPendingQuestions(state);
        const graceMs = rt.stopGraceMs ?? STOP_GRACE_MS;
        rt.log(`job ${job.id}: stop requested, letting the agent finish its current step (${graceMs}ms grace)`);
        state.graceTimer = setTimeout(() => {
            if (state.phase === 'ended' || state.phase === 'concluding' || down(state)) return;
            recordEnding(state, 'stop');
            rt.log(`job ${job.id}: the agent did not stop within ${graceMs}ms, killing the runner`);
            state.abortNow();
            void killAgent(rt, job, control).catch(() => {});
        }, graceMs);
        state.graceTimer.unref?.();
    }
    // Retry a failed restoration on the next stop heartbeat; the grace timer remains armed.
    await updateQuestionDeadline(rt, job, state).catch((error: Error) => {
        rt.log(`job ${job.id}: could not resume the draining runtime budget: ${error.message}`);
    });
}

/**
 * Whether a heartbeat verdict may no longer act on the attempt: a handed-over attempt's runner
 * belongs to the next claim (issue #792), and a concluding one's outcome is staged — only the
 * teardown that follows its verdict ends it (issue #821).
 */
const beyondVerdicts = (state: JobState): boolean => state.ending?.kind === 'handover' || state.phase === 'concluding';

/** Delivers the answers a heartbeat carries to the questions still pending, and settles the paused budget. */
async function deliverVerdictAnswers(
    rt: LoopRuntime,
    job: BoardJob,
    state: JobState,
    verdict: HeartbeatVerdict
): Promise<void> {
    if (
        typeof verdict === 'object' &&
        !verdict.cancelRequested &&
        !state.draining &&
        (state.pendingQuestions.size > 0 || state.questionPausedAt !== null || verdict.answeredQuestions?.length)
    ) {
        await deliverAnswers(rt, job, state, verdict.answeredQuestions ?? []).catch((error: Error) => {
            rt.log(`job ${job.id}: could not update the question runtime budget: ${error.message}`);
        });
    }
}

/**
 * The control endpoint a stop can be raised on cooperatively: only when a poller has actually read it,
 * otherwise nothing would ever hear it. A pending question is a runner in contact however it got there:
 * its POST counts as a poll.
 */
function drainableControl(rt: LoopRuntime, state: JobState): string | null {
    const server = rt.gates?.server;
    if (!state.running || state.control === null) return null;
    return server?.controlPolled(state.control) || server?.hasPendingQuestion(state.control) ? state.control : null;
}

/** Folds one heartbeat verdict into the attempt's state, and kills the runner when it stands down. */
export async function applyHeartbeatVerdict(
    rt: LoopRuntime,
    job: BoardJob,
    state: JobState,
    verdict: HeartbeatVerdict
) {
    const { runner, log } = rt;
    if (beyondVerdicts(state)) return;
    await deliverVerdictAnswers(rt, job, state, verdict);
    // The answer delivery above awaited: a handover that landed meanwhile retained the runner.
    if (beyondVerdicts(state)) return;
    if (verdict === 'lost') {
        recordEnding(state, 'lost');
        // Past the launch the runner is the new holder's to take over: nothing here kills it or closes its tokens.
        if (state.ending?.kind === 'lost' && state.launched) {
            log(`job ${job.id}: lease lost past the launch, leaving the runner to the next claim`);
            state.abortNow();
            state.wake();
            state.signalHandover();
            return;
        }
        log(`job ${job.id}: lease lost, killing the runner`);
    } else if (verdict === 'removed') {
        recordEnding(state, 'removed');
        log(`job ${job.id}: removed while it ran, killing the runner`);
    } else if (verdict.cancelRequested) {
        // While the agent runs, with a control endpoint to raise the stop on: cooperative.
        // Everywhere else (setup, the gates and later phases, a driver with no endpoint) the stop
        // is today's immediate stand-down.
        const control = drainableControl(rt, state);
        if (control !== null) return startDraining(rt, job, state, control);
        recordEnding(state, 'stop');
        log(`job ${job.id}: stop requested, killing the runner`);
    }
    if (!down(state)) return;
    // The flag lands before the kill: the setup races read the abort signal,
    // so a slow teardown never holds the stand-down in place.
    state.abortNow();
    if (state.launched) {
        await killAgent(rt, job, state.control);
    } else {
        // Before the spawn there is no container — the kill is best-effort
        // reclamation, and both executors swallow its rejections. Awaited,
        // an unresponsive daemon would hold `beating`, and with it settle()
        // and the stop's park, past the setup poll period. Settlement must
        // not wait on it; the kill still runs, unobserved.
        void runner.kill(job).catch(() => {});
    }
}

/**
 * Whether the heartbeat still beats: until the attempt ends or stands down — except while it concludes,
 * when it renews the lease the verdict needs until the quiesce, whatever ending was recorded (issue #828).
 */
const renewing = (state: JobState): boolean =>
    state.phase !== 'ended' && (state.phase === 'concluding' || !down(state));

/** Whether the output pump still writes: until the attempt ends or loses its lease. */
const pumping = (state: JobState): boolean => state.phase !== 'ended' && !lostOf(state);

/** One heartbeat poll: reads the board's verdict (rate-limiting its own failure log), and folds it in. */
async function beat(rt: LoopRuntime, job: BoardJob, state: JobState, complained: boolean): Promise<boolean> {
    const { board, log } = rt;
    let verdict: HeartbeatVerdict | undefined;
    try {
        // Bounded by a lease third (one beat period): a request the board never answers must not stall the
        // beats past the lease. An aborted beat throws below and is inconclusive, never a verdict.
        verdict = await board.heartbeat(job, AbortSignal.timeout(heartbeatPeriodMs(rt.config)));
        complained = false;
    } catch (e) {
        // A board that is briefly unreachable is not a lost lease. Keep working: the
        // lease outlives several missed beats, and giving up here would kill a run
        // over one failed request. Rate-limited to the first failure in a row — at
        // the setup poll's pace a long outage must not write a log line every two
        // seconds.
        if (!complained) {
            complained = true;
            log(`job ${job.id}: heartbeat failed, continuing: ${(e as Error).message}`);
        }
    }
    if (verdict !== undefined) await applyHeartbeatVerdict(rt, job, state, verdict);
    return complained;
}

/**
 * Beats until the run finishes.
 *
 * The beat comes FIRST, not after a full period: the stop flag is read the moment the attempt
 * exists, so the first observation never waits out a whole lease third (issue #126). The pace
 * is `SETUP_POLL_MS` while the runner has not spawned — the phase a stop must interrupt in
 * seconds — and a third of the lease once it has.
 *
 * A 409 means the lease was reclaimed while this container was still working: the job belongs
 * to another worker now, so this one is killed rather than left to finish and report. The board
 * would refuse the report anyway — but by then the two runs have both been writing to the same
 * checkout, which is the thing actually worth preventing. A 404 means the thread was REMOVED
 * (issue #41): same kill, and nothing left to park against or report to. A Stop — the board
 * answers `cancelRequested` on a still-held beat — kills the container too, and the board
 * settles the run `stopped` when the park lands: the turn ends, and the session survives for
 * the follow-up that continues the conversation.
 */
export function heartbeat(rt: LoopRuntime, job: BoardJob, state: JobState): Promise<void> {
    const { config, sleep } = rt;
    // Once launched, never slower than the control poll: a Stop reaches the agent within one
    // `RUN_CONTROL_POLL_MS` however long the lease is (issue #442).
    const every = Math.min(RUN_CONTROL_POLL_MS, heartbeatPeriodMs(config));
    return (async () => {
        let complained = false;
        while (renewing(state)) {
            complained = await beat(rt, job, state, complained);
            if (!renewing(state)) return;
            // Raced against the run finishing, not simply awaited. A plain sleep would hold
            // every finished job for the remainder of the period before its result could be
            // reported; a settled stop, lease or Remove resolves `abort` for the setup races
            // and `woken` ends the loop outright.
            await Promise.race([sleep(state.launched ? every : SETUP_POLL_MS), state.woken]);
        }
    })();
}

/** The runtime report for one flush, derived from the sample and the tail being flushed together. */
function buildRuntimeReport(sample: RuntimeSample, latest: string): RuntimeReport {
    return {
        cpuPercent: sample.cpuPercent,
        memUsedMb: sample.memUsedMb,
        memPercent: sample.memPercent,
        // The attempt's service fleet, when the attempt declared any — absent
        // (never an empty array) otherwise, so the wire shape of a service-less
        // job is byte-identical to what it always was.
        ...(sample.services ? { services: sample.services } : {}),
        ...(sample.transcriptExport ? { transcriptExport: sample.transcriptExport } : {}),
        // Derived at flush, from the tail being flushed — the activity line and
        // the numbers must describe the same moment.
        activity: currentActivity(latest),
        sampledAt: sample.sampledAt,
    };
}

/**
 * Streams the runner's output tail to the board while the run goes, so the dashboard shows the
 * work instead of a spinner.
 *
 * The runner calls back with its newest tail whenever it has one; this flushes at most once
 * per period, and only what changed — the runner's chunk rate is the container's, the board's
 * is this period. A sample of the container's vitals rides the same flush: at most one
 * `docker stats` round-trip in flight at a time, kicked each period, and a flush fires when
 * EITHER the tail or the sample changed — a quiet agent burning CPU is exactly the "is it
 * stuck" question this answers, so the sample alone is worth a report (it travels only once a
 * tail exists; a run with no output at all has nothing to show vitals beside).
 *
 * Deliberately not a second heartbeat. A `409` here is NOT acted on — the heartbeat is the one
 * place that decides a superseded run must die (docs/jobs.md) — and a failure costs freshness,
 * never the run, because the complete report carries the final tail regardless.
 */
/**
 * The output pump's whole mutable state, bundled so every step function takes it as one value:
 * the newest tail (set from outside, by the returned callback), what was last flushed of it and
 * of the runtime sample, whether a sample fetch is already in flight, and the flush failure
 * rate-limit flag.
 */
interface OutputPump {
    latest: string | null;
    /** Epoch ms of the last CHANGED tail — the freshness fact a timeout note keys on (issue #339). */
    lastOutputAt: number | null;
    sent: string | null;
    sample: RuntimeSample | null;
    sentSample: RuntimeSample | null;
    sampling: boolean;
    complained: boolean;
    /** Each service the sampler saw die and what it read of its ending, by name (issue #487). */
    dead: Map<string, DeadService>;
    /** The progress write in flight, or the last one settled: every write chains on it, so none overtakes another. */
    writing: Promise<unknown>;
    /** True once drained for a park: no periodic write starts after it. */
    drained: boolean;
}

/** One progress write, after any still in flight: a later tail never lands before an older one. */
function serialFlush(rt: LoopRuntime, job: BoardJob, pump: OutputPump): Promise<'held' | 'lost' | 'skip'> {
    const next = pump.writing.then(() => flushIfChanged(rt, job, pump));
    pump.writing = next.catch(() => undefined);
    return next;
}

/**
 * Carries a dead service's exit, reason, log tail and hint (issue #487) into the fleet the sample
 * reports, read once — the first sample that sees it dead, before the teardown deletes the logs —
 * and tells the agent through the gate endpoint when one is newly dead. A probe that cannot read
 * the fleet costs the detail, never the sample.
 */
async function withDeadDetail(
    at: { rt: LoopRuntime; job: BoardJob; state: JobState; pump: OutputPump },
    services: ServiceStatus[]
): Promise<ServiceStatus[]> {
    const { rt, job, state, pump } = at;
    const fresh = services.some((s) => DEAD_SERVICE_STATES.has(s.state) && !pump.dead.has(s.name));
    if (fresh) {
        const found = await rt.runner.deadServices(job).catch((): DeadService[] => []);
        for (const dead of found) pump.dead.set(dead.name, dead);
        if (state.gateToken && found.length > 0) {
            rt.gates?.server.setDeadServices(
                state.gateToken,
                [...pump.dead.values()].map((dead) => deadServiceNote(dead, false)).join('\n\n')
            );
        }
    }
    return services.map((service) => {
        const dead = pump.dead.get(service.name);
        if (!dead || !DEAD_SERVICE_STATES.has(service.state)) return service;
        const hint = serviceHint(dead.logTail);
        return {
            ...service,
            exitCode: dead.exitCode,
            reason: dead.reason,
            logTail: dead.logTail,
            ...(hint ? { hint } : {}),
        };
    });
}

/** Kicks off one runtime sample fetch, unless one is already in flight; the pump holds the newest. */
function kickSample(rt: LoopRuntime, job: BoardJob, state: JobState, pump: OutputPump): void {
    if (pump.sampling) return;
    pump.sampling = true;
    rt.runner
        .sampleRuntime(job)
        .then(async (sampled) => {
            // The exporter's vitals ride the sample: a run whose container could not be read still
            // reports how far behind its transcript upload is.
            const exporting = state.transcriptExport?.vitals;
            const read: Omit<RuntimeSample, 'sampledAt'> | null =
                sampled ?? (exporting ? { cpuPercent: null, memUsedMb: null, memPercent: null } : null);
            if (!read) return;
            const services = read.services ? await withDeadDetail({ rt, job, state, pump }, read.services) : undefined;
            pump.sample = {
                ...read,
                ...(services ? { services } : {}),
                ...(exporting ? { transcriptExport: exporting } : {}),
                sampledAt: new Date().toISOString(),
            };
        })
        .catch(() => {})
        .finally(() => {
            pump.sampling = false;
        });
}

/**
 * Flushes the pump's newest tail+sample pair to the board, when either changed since the last
 * flush; answers `'skip'` when there is nothing new, or a flush just failed (rate-limited to one
 * log line per outage) — the caller simply continues either way. `'lost'` ends the pump outright.
 */
async function flushIfChanged(rt: LoopRuntime, job: BoardJob, pump: OutputPump): Promise<'held' | 'lost' | 'skip'> {
    const { board, log } = rt;
    const sampled = pump.sample !== pump.sentSample;
    if (pump.latest === null || (pump.latest === pump.sent && !sampled)) return 'skip';
    const latest = pump.latest;
    pump.sent = latest;
    pump.sentSample = pump.sample;
    const runtime: RuntimeReport | null = pump.sample ? buildRuntimeReport(pump.sample, latest) : null;
    try {
        const verdict = await board.progress(job, latest, runtime ?? undefined);
        pump.complained = false;
        return verdict;
    } catch (e) {
        // Rate-limited to the first failure in a row: a board unreachable for a
        // three-hour session must not write a log line every two seconds.
        if (!pump.complained) {
            pump.complained = true;
            log(`job ${job.id}: could not stream output, continuing: ${(e as Error).message}`);
        }
        return 'skip';
    }
}

/**
 * Starts the output pump and answers its two handles: `push`, the callback the runner hands its
 * newest tail to (unchanged from before), and `snapshot`, the liveness read a timed-out run's
 * kill note is built from (issue #339). The stamp lands only when the tail CHANGED — kubernetes's
 * repeated identical log polls must not fake freshness.
 */
export function watchOutput(
    rt: LoopRuntime,
    job: BoardJob,
    state: JobState
): { push: (tail: string) => void; snapshot: () => TimeoutActivity; flush: (tail: string) => Promise<void> } {
    const { sleep } = rt;
    const pump: OutputPump = {
        latest: null,
        lastOutputAt: null,
        sent: null,
        sample: null,
        sentSample: null,
        sampling: false,
        dead: new Map(),
        complained: false,
        writing: Promise.resolve(),
        drained: false,
    };
    state.drainOutput = async () => {
        pump.drained = true;
        let settled = false;
        void pump.writing.then(() => {
            settled = true;
        });
        const deadline = Date.now() + OUTPUT_DRAIN_MS;
        while (!settled && Date.now() < deadline) await sleep(OUTPUT_DRAIN_TICK_MS);
    };
    void (async () => {
        while (pumping(state)) {
            await Promise.race([sleep(PROGRESS_MS), state.woken]);
            if (!pumping(state)) return;
            // The pump starts with the attempt now, but the runner does not exist until
            // launch — sampling before that is a daemon lookup per period that can answer
            // nothing (issue #126 moved the start earlier to cover the setup phase).
            if (!state.launched || pump.drained) continue;
            kickSample(rt, job, state, pump);
            const verdict = await serialFlush(rt, job, pump);
            // The board no longer recognises this attempt. Killing the container is the
            // heartbeat's verdict alone; this pump just stops talking.
            if (verdict === 'lost') return;
        }
    })();
    return {
        push: (tail) => {
            if (tail !== pump.latest) pump.lastOutputAt = Date.now();
            pump.latest = tail;
        },
        snapshot: () => ({ lastOutputAt: pump.lastOutputAt, activity: currentActivity(pump.latest) }),
        // The run's own last word, streamed now: what a verdict-less end (a park) leaves the board.
        // It waits out a write still in flight, so the park follows every tail the board was sent.
        flush: async (tail) => {
            if (tail === '') return;
            pump.latest = tail;
            await serialFlush(rt, job, pump);
        },
    };
}
