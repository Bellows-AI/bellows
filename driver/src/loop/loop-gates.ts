import { randomUUID } from 'node:crypto';
import type { BoardJob, DeclaredGate } from '../board/board.js';
import type { GateRunRecord } from '../board/board-gate-runs.js';
import { gateEnvBody, setupTimeoutMs } from '../claim.js';
import { tailBytes, type DeadService } from '../runner.js';
import { stepLost } from '../step-control.js';
import { declaredTimeoutMs, type GateLedger, type GateRun } from '../gates.js';
import { gateIdentity } from '../gate-identity.js';
import { recordGateRun, type GateEnd } from '../gate-record.js';
import { GATE_RUNS_READ_MS, reusableRun, reusedReport } from './gate-reuse.js';
import { clearPendingQuestions, down, raceStep } from './loop-attempt.js';
import { SUPERVISOR_ENV } from '../supervisor-contract.js';
import { takeoverBoundMs } from '../supervisor-plan.js';
import type { JobState } from './loop-attempt.js';
import { askGithubToken } from './loop-github.js';
import { createPublishRelay } from './loop-publish.js';
import { createQuestionRelay } from './loop-questions.js';
import { createReviewRelay } from './loop-review.js';
import { attachConnection } from './loop-connection.js';
import { attachCheckpoint, attachTranscriptExport } from './loop-export.js';
import type { AttemptCtx, GateStack, LoopRuntime } from './loop-types.js';
import { checkoutKey } from '../publish/publish.js';

/** The report must fit the board's 128 KiB body: the raw per-gate tail budget, and its floor. */
const GATES_REPORT_BUDGET_BYTES = 16384;
const PER_GATE_OUTPUT_FLOOR_BYTES = 1024;
const REFUSED_TO_RUN_EXIT_CODE = 125;
/** Heads the output of a gate that never ran because the environment's `setup` command failed. */
const SETUP_FAILED_PREFIX = '[setup failed — the gate did not run]\n';

/**
 * One gated job's live registration: the checkout key its environment is filed under, the token
 * the runner's agent presents to the ad-hoc endpoint, and the gates the end-of-run pass runs —
 * every gate the job's `.bellows.yaml` declared but the `onDemand` ones, which only the token
 * reaches. Lives from before the agent starts until the run's exit paths have all been walked.
 * The image and env body the environment was created with ride along so the gates pass can
 * re-acquire — carried, not recomputed, because a body recomputed at gates time would fold in
 * the minted `BELLOWS_GATE_*` lines that only exist after `beginGates` has registered them.
 */
export interface GateSession {
    key: string;
    token: string;
    image: string;
    envBody: string;
    declared: readonly DeclaredGate[];
    /** Whether the end-of-run pass runs: gates are declared, or setup failed and must be retried. */
    endPass: boolean;
    /** The gates list the last declared pass left on the board; absent before one ran. */
    lastReports?: GateReport[];
    /** The claim of the run this session gates (`runClaimSeqOf`): the gate-run record is keyed by it. */
    runClaimSeq: number;
    /** The gate-run record's probe, identity and board write (issue #983). */
    ledger: GateLedger;
}

export interface GateFailure {
    name: string;
    exitCode: number;
    output: string;
}

/** What one gate looks like on the board, at one moment. */
export type GateReport = {
    name: string;
    status: 'pending' | 'running' | 'passed' | 'failed';
    exitCode: number | null;
    output: string | null;
    /** When a `running` entry started (ISO); the settled entry carries none. */
    startedAt?: string;
    /** The recorded execution this entry is (issue #983); absent for a gate no record covers. */
    executionId?: string;
    /** Set when the gate was not launched: it is served from an earlier verified pass. */
    reused?: { executionId: string; finishedAt: string | null; reason: string };
};

/** Whether the job declares gates or setup, so that a gate environment is started for it at all. */
const declaresGateEnvironment = (job: BoardJob): boolean =>
    Boolean(job.gates && (job.gates.gates.length || job.gates.setup));

/**
 * Puts the pair the agent reaches the ad-hoc gate endpoint with onto `job.gateEnv`, once. The token
 * is registered only by `beginGates`; until then the endpoint answers it nothing.
 */
async function ensureGatePair(gates: GateStack, job: BoardJob): Promise<string> {
    const port = await gates.server.listen();
    job.gateEnv = {
        ...job.gateEnv,
        BELLOWS_GATE_URL: job.gateEnv?.BELLOWS_GATE_URL ?? gates.advertiseUrl(port),
        BELLOWS_GATE_TOKEN: job.gateEnv?.BELLOWS_GATE_TOKEN ?? randomUUID(),
    };
    return job.gateEnv.BELLOWS_GATE_TOKEN as string;
}

/**
 * Mints the agent's gate pair for a job that declares gates or setup, before the first runner step.
 * A kubernetes group is one pod whose env Secret is written when that step (the checkout sync)
 * makes it, long before `beginGates` runs, and a pod's env cannot change afterwards. Best-effort
 * like `openRunControl`: `beginGates` mints the pair itself when this could not, which is all a
 * docker agent container, created later, needs.
 */
export async function mintGateCredentials(rt: LoopRuntime, job: BoardJob): Promise<void> {
    const { gates } = rt;
    if (!gates || !declaresGateEnvironment(job) || !checkoutKey(job)) return;
    try {
        await ensureGatePair(gates, job);
    } catch (e) {
        rt.log(`job ${job.id}: could not mint the gate credentials early: ${(e as Error).message}`);
    }
}

/**
 * Ensures the job's gate environment, registers its ad-hoc token and runs `environment.setup` in
 * it (issue #733), or answers null for a job that declares neither gates nor setup. The token and
 * URL ride the claim's env into the runner's env file — appended after the claim's own lines,
 * where docker's last-wins rule keeps a member-scoped `BELLOWS_GATE_TOKEN` from minting itself a
 * gate credential.
 */
export async function beginGates(
    rt: LoopRuntime,
    job: BoardJob,
    state: JobState,
    opts: { takeover?: boolean; runClaimSeq?: number } = {}
): Promise<GateSession | null> {
    const { gates } = rt;
    // A checkout that declares only `setup` still gets the environment: setup runs in it before
    // the agent starts (issue #733).
    if (!job.gates || (!job.gates.gates.length && !job.gates.setup)) return null;
    if (!gates) {
        // Declared gates with no gate environment were refused by the re-read; only setup is left.
        rt.log(`job ${job.id}: environment.setup skipped — this driver has no gate environment configured`);
        return null;
    }
    // The gates run in the task checkout (issue #35) — the tree the run edits — so the
    // environment is keyed by `checkoutKey`, `<root id>/<repo segment>`. A job that names no
    // repository has no checkout and no gates either.
    const key = checkoutKey(job);
    if (!key) return null;
    // The environment starts with the claim's own env — resolved for THIS author and repo — and a
    // GitHub token fetched now, which is what a test suite needs to reach the forge.
    const envBody = await gateEnvNow(rt, job, 'the gate environment');
    // The job is the gate manager's attempt context: the group whose gate container runs it.
    await gates.manager.acquire(key, job.gates.image, envBody, { job, signal: state.signal });
    // A stand-down that landed while the acquire was in flight leaves the environment here:
    // the caller has stopped waiting and holds no session to release through (issue #126).
    if (down(state)) {
        gates.manager.release(key, job);
        return null;
    }
    try {
        const token = await ensureGatePair(gates, job);
        const runClaimSeq = opts.runClaimSeq ?? job.claimSeq;
        const ledger = gateLedger(rt, job, runClaimSeq);
        gates.server.register(token, {
            key,
            image: job.gates.image,
            envBody,
            job,
            gates: job.gates.gates,
            freshEnv: () => gateEnvNow(rt, job, 'a gate run'),
            ledger,
            // The agent's ad-hoc gate found the supervisor lost: the attempt's, once its run is over.
            onInfraLoss: (reason) => {
                state.gateLoss ??= reason;
            },
        });
        // The pair is on `job.gateEnv`, beside `env` and not inside it: the reserved-name filter keeps a
        // member-configured BELLOWS_GATE_* out of the claim lines, and these are the driver's own minted values.
        // A taken-over run's environment setup ran before the agent did (#829).
        if (!opts.takeover) await runEnvironmentSetup(rt, job, key, state);
        // The same check at the far edge — listen can take its time, and nothing registered
        // or live may survive a stand-down detected inside this function.
        if (down(state)) {
            gates.server.unregister(token);
            gates.manager.release(key, job);
            return null;
        }
        const declared = job.gates.gates.filter((gate) => !gate.onDemand);
        return {
            key,
            token,
            image: job.gates.image,
            envBody,
            declared,
            endPass: declared.length > 0 || Boolean(job.setupFailure),
            runClaimSeq,
            ledger,
        };
    } catch (e) {
        // Filed but never registered: the checkout is forgotten again, so no entry outlives the claim.
        gates.manager.release(key, job);
        throw e;
    }
}

/** How much of a failed setup's output the agent's turn context quotes. */
const SETUP_FAILURE_TAIL_BYTES = 2048;

/**
 * The turn context a failed `environment.setup` adds (issue #733): the agent still starts, told
 * the exit code and the output's tail so it can fix the install. Appended to the board's own
 * context, which it never replaces.
 */
export const withSetupFailureContext = (
    turnContext: string | undefined,
    failure: NonNullable<BoardJob['setupFailure']>
): string =>
    [
        ...(turnContext ? [turnContext] : []),
        'Environment setup failed',
        'The `environment.setup` command in .bellows.yaml ran before this turn and failed ' +
            `(exit ${failure.exitCode ?? 'unknown'}). ` +
            'Dependencies it installs may be missing. Fix the cause if it is in the repository; ' +
            'the end-of-run gate pass retries setup first, and fails as a setup failure while it still fails.',
        `Setup output (tail):\n${failure.output}`,
    ].join('\n\n');

/** The verdict line for a pre-agent setup failure no gate pass reported. */
export const setupFailureNote = (failure: NonNullable<BoardJob['setupFailure']>): string =>
    `[driver] environment.setup failed before the agent started (exit ${failure.exitCode ?? 'unknown'}):\n` +
    failure.output;

/**
 * Runs the attempt's `environment.setup` in its gate environment before the agent starts (issue
 * #733), under `setupTimeoutMs` and raced against the stand-down. Records the time it took on the
 * job — the runner's deadline is what is left of the run budget — and, on a failure, tells the
 * agent through the turn context. Never refuses the run: the end-of-run gates retry setup and
 * fail as `[setup failed — the gate did not run]` while it still fails. The last step of
 * `beginGates`, so a stand-down during it releases the environment and spawns nothing.
 */
async function runEnvironmentSetup(rt: LoopRuntime, job: BoardJob, key: string, state: JobState): Promise<void> {
    const manager = rt.gates?.manager;
    if (!manager || !job.gates?.setup) return;
    await sizeGateForVerify(rt, job);
    const started = Date.now();
    const running = manager
        .runSetup(key, { signal: state.signal, timeoutMs: setupTimeoutMs(rt.config) })
        .catch(refusedToRun);
    const raced = await raceStep(state.signal, running);
    const run = raced?.value;
    if (!run || down(state)) return;
    job.setupMs = Date.now() - started;
    rt.log(`job ${job.id}: environment.setup exit ${run.exitCode} in ${job.setupMs}ms`);
    if (run.exitCode === 0) return;
    job.setupFailure = { exitCode: run.exitCode, output: tailBytes(run.output, SETUP_FAILURE_TAIL_BYTES) };
    job.turnContext = withSetupFailureContext(job.turnContext, job.setupFailure);
}

/**
 * Opens the run-control channel for one attempt about to launch, gated or not (issue #442): three
 * tokens scoped to this lease. The supervisor's goes to the task supervisor alone
 * (`job.supervisorEnv`) so it can read a Stop the board raised, relay the agent's questions and run
 * the supervised steps; the exporter's and the agent's, beside it in `job.supervisorEnv`, open only
 * the transcript export and only the publish and review routes. Neither leaves the supervisor: it
 * relays the agent's and the exporter's requests, attaching the role's token (#829). Best-effort — a driver whose endpoint cannot bind keeps today's immediate-kill
 * Stop, said out loud, instead of refusing every job over a feature.
 */
export async function openRunControl(rt: LoopRuntime, job: BoardJob, state: JobState): Promise<void> {
    const { gates } = rt;
    if (!gates) return;
    try {
        const port = await gates.server.listen();
        // Three tokens of one lease: the supervisor's (stop, kill, questions, steps) never leaves
        // the supervisor; the exporter's opens only the transcript export; the agent's only publish
        // and review.
        const token = randomUUID();
        const agentToken = randomUUID();
        const exporterToken = randomUUID();
        gates.server.openControl(
            token,
            createQuestionRelay(rt, job, state),
            createPublishRelay(rt, job, state),
            createReviewRelay(rt, job, state)
        );
        attachConnection({ rt, job, state }, token);
        gates.server.grantAgent(token, agentToken);
        gates.server.grantExporter(token, exporterToken);
        attachTranscriptExport({ rt, job, state }, token);
        attachCheckpoint({ rt, job }, token);
        const url = gates.advertiseUrl(port);
        job.supervisorEnv = {
            [SUPERVISOR_ENV.controlUrl]: url,
            [SUPERVISOR_ENV.controlToken]: token,
            [SUPERVISOR_ENV.agentToken]: agentToken,
            [SUPERVISOR_ENV.exportToken]: exporterToken,
        };
        state.control = token;
    } catch (e) {
        rt.log(
            `job ${job.id}: could not open the run-control endpoint, a Stop will kill at once: ${(e as Error).message}`
        );
    }
}

/**
 * Closes the attempt's control token, if one was opened: the token's questions go with it and the
 * bridge gets 401 from here on.
 */
export function closeRunControl(rt: LoopRuntime, state: JobState): void {
    clearPendingQuestions(state);
    if (state.control === null) return;
    rt.gates?.server.closeControl(state.control);
    // Closed once: `end` (`loop-conclusion.ts`) closes it after the group's `finish`.
    state.control = null;
}

/**
 * Leaves the attempt's control token to a newer holder (#829): its group is retained, so the token
 * is hung up on — never answered 401, which the group's supervisor reads as the end of its attempt —
 * until the group's takeover bound passes and the holder it waits for has named itself.
 */
export function departRunControl(rt: LoopRuntime, state: JobState): void {
    clearPendingQuestions(state);
    if (state.control === null) return;
    rt.gates?.server.departControl(state.control, takeoverBoundMs(rt.config));
    state.control = null;
}

/** What the declared-gates pass runs against: the attempt's state, and the tree the run left (null when unread). */
export interface GatesPass {
    state: JobState;
    treeAfter: string | null;
}

/** The declared gates of one running attempt: what `runDeclaredGates` and its helper share. */
interface GatesRunCtx {
    rt: LoopRuntime;
    job: BoardJob;
    gateSession: GateSession;
    state: JobState;
    /** Aborted by a stop, lost lease or Remove: the manager cancels the gate it is running. */
    signal: AbortSignal;
}

/**
 * The gate environment's body with a GitHub token asked now: every gate run starts on a token of
 * its own, and a run is never renewed (docs/connections.md).
 */
const gateEnvNow = async (rt: LoopRuntime, job: BoardJob, what: string): Promise<string> =>
    gateEnvBody(withoutGatePair(job), await askGithubToken(rt, job, what));

/**
 * `beginGates` adds the gate server's own pair to `job.gateEnv` for the agent; a gate run never
 * gets it, or a gate could call `/run` on its own checkout and wait behind itself.
 */
const withoutGatePair = (job: BoardJob): BoardJob => ({
    ...job,
    gateEnv: Object.fromEntries(Object.entries(job.gateEnv ?? {}).filter(([name]) => !GATE_SERVER_PAIR.includes(name))),
});

/** The gate env body a gate's identity hashes: the claim's env, without the gate server's pair or a GitHub token. */
export const stableGateEnvBody = (job: BoardJob): string => gateEnvBody(withoutGatePair(job), null);

/**
 * The gate-run record of one claim (issue #983): the runner's tree probes, the identity of a gate's
 * configuration — its env WITHOUT the per-run GitHub token, keyed by the board token — and the board
 * write. The identity is computed from the current claim's job, never from a registered copy.
 */
export function gateLedger(rt: LoopRuntime, job: BoardJob, runClaimSeq: number): GateLedger {
    return {
        probe: (signal, sinceMs) => rt.runner.probeGateTree(job, sinceMs ?? null, signal),
        identity: (gate) => gateIdentity(rt.config.boardToken, job, gate, stableGateEnvBody(job)),
        write: async (row, signal) => (await rt.board.gateRun(job, { runClaimSeq, ...row }, signal)) === 'ok',
    };
}

/**
 * A gate the transport could not run is a failed gate (125) — but a lost supervisor (`stepLost`,
 * issue #773) is no verdict on the gate at all: it is rethrown, and the attempt is interrupted.
 */
const refusedToRun = (e: Error): GateRun => {
    if (stepLost(e)) throw e;
    return { exitCode: REFUSED_TO_RUN_EXIT_CODE, output: e.message };
};

/**
 * Asks the runner to size the gate container for the setup and the gates (issue #773). Best-effort:
 * whatever it answers, the setup and the gates run.
 */
export async function sizeGateForVerify(rt: LoopRuntime, job: BoardJob): Promise<void> {
    await rt.runner.resizeGate(job, 'verify').catch(() => false);
}

/** The gate server's URL and token, the agent's alone. */
const GATE_SERVER_PAIR: readonly string[] = ['BELLOWS_GATE_URL', 'BELLOWS_GATE_TOKEN'];

/**
 * One declared gate's re-acquire-then-run outcome, folding a re-acquire failure into a failed gate.
 * The run is recorded (issue #983) as a `completion` execution: best-effort, since a board hiccup
 * costs the record, never the gating; exactly one terminal row is written on every exit.
 */
async function runOneGate(ctx: GatesRunCtx, gate: DeclaredGate): Promise<{ run: GateRun; executionId: string } | null> {
    const { rt, job, gateSession, state, signal } = ctx;
    const { gates } = rt;
    if (!gates) return null;
    const record = recordGateRun(gateSession.ledger, {
        gate,
        source: 'completion',
        filtered: false,
        requireRecord: false,
        signal,
    });
    let end: GateEnd = { error: new Error('the gate run ended without an answer') };
    let failure: Error | null = null;
    try {
        const run = await gateEnvNow(rt, job, `gate ${gate.name}`)
            .then((envBody) => gates.manager.acquire(gateSession.key, gateSession.image, envBody, { job }))
            .then(() => {
                // The heartbeat can mark the lease lost — or the task stopped or removed — while
                // acquire is pending: a slow revival or cluster request outlives the beat that said
                // so. Starting the gate then would be dead work, on a checkout another attempt may
                // own: the same refusal the check before the acquire makes.
                if (down(state)) return null;
                return gates.manager.runGate(gateSession.key, gate.name, gate.command, {
                    signal,
                    timeoutMs: declaredTimeoutMs(gate),
                    execution: record.execution,
                });
            })
            .catch((e: Error) => {
                failure = e;
                return refusedToRun(e);
            });
        if (run === null) {
            end = { cancelled: true };
            return null;
        }
        end = failure ? { error: failure } : { run, cancelled: down(state) };
        return { run, executionId: record.executionId };
    } finally {
        await record.finish(end);
    }
}

/** A finished gate's report entry, and the text a failure carries to the board. */
function settledGate(gate: DeclaredGate, outcome: GateRun, perGate: number): { entry: GateReport; text: string } {
    // A failed setup is not this gate's verdict: the output names it so the board's `gates`
    // and the job's `output` tell the two apart.
    const text = outcome.setupFailed ? `${SETUP_FAILED_PREFIX}${outcome.output}` : outcome.output;
    return {
        entry: {
            name: gate.name,
            status: outcome.exitCode !== 0 ? 'failed' : 'passed',
            exitCode: outcome.exitCode,
            output: tailBytes(text, perGate),
        },
        text,
    };
}

/**
 * The task tree's fingerprint as the run left it, before the gates; compared with the startup
 * sync's to answer whether the tree moved. Null when unknown: no before-fingerprint, or a probe
 * that failed.
 *
 * Ad-hoc admission closes and the runs in flight settle first (issue #983): an on-demand gate still
 * draining may write the tree, and a pass reused at completion certifies exactly this read, with every
 * ad-hoc run already in the record.
 */
export async function probeTreeNow(ctx: AttemptCtx): Promise<string | null> {
    const { rt, job, treeBefore, state } = ctx;
    if (ctx.gateSession && rt.gates) await raceStep(state.signal, rt.gates.server.quiesce(ctx.gateSession.token));
    // An adopted run has no synced fingerprint, but its tree is still the revision evidence binds to.
    if (treeBefore === null && !ctx.adopted && !ctx.takeover) return null;
    // The attempt's own signal is the probe's transport abort AND the race: a stand-down cancels
    // the request in flight and stops waiting on it, and the caller rechecks (issue #472).
    const raced = await raceStep(
        state.signal,
        rt.runner.probeTree(job, state.signal).catch(() => null)
    );
    return raced?.value ?? null;
}

/** A walk over the gates that found a reused pass voided by a later change of the tree. */
const STALE_REUSE = Symbol('stale-reuse');
/** One gate that ran and passed, in a walk that goes on. */
const GATE_PASSED = Symbol('gate-passed');

/**
 * Runs every declared gate in order, reporting each state change to the board as it happens.
 * The report REPLACES the stored list — every report carries the whole list so the task view
 * always shows all gates at their current state, never a summary that arrived out of order.
 * That list is left on `gateSession.lastReports`, so a checkpoint can keep what the board was last told.
 *
 * Both the reports and a gate whose exec itself throws are best-effort against the RUN, never
 * against the VERDICT: a board hiccup costs the live view, not the gating. A gate that cannot
 * run at all is a failed gate — an exit code of 125 is docker's "container not there", and
 * treating it as a pass would be the one lie this loop must never tell.
 *
 * Each gate re-acquires the environment first, exactly as the ad-hoc endpoint does: every gate
 * run starts on a GitHub token of its own (docs/connections.md).
 */
export async function runDeclaredGates(
    rt: LoopRuntime,
    job: BoardJob,
    gateSession: GateSession,
    pass: GatesPass
): Promise<GateFailure | null> {
    const { gates, log } = rt;
    const { state, treeAfter } = pass;
    if (!gates) return null;
    // The attempt's own signal is the gate transport's abort: a stand-down cancels the gate in
    // flight, not only the ones after it, and no second controller exists to keep in step
    // (issue #472).
    const runCtx: GatesRunCtx = { rt, job, gateSession, state, signal: state.signal };
    // No declared gate to retry a failed setup before: the pass is that retry alone.
    if (gateSession.declared.length === 0) return retryFailedSetup(runCtx);
    const results: GateReport[] = [];
    gateSession.lastReports = results;
    const report = async (): Promise<void> => {
        try {
            // A copy, not the live array: the report is a state-at-a-moment, and a reader
            // (or stub) holding it must not see gates move after the fact.
            // A 409 here is not a kill order — the heartbeat is the one place that decides a
            // superseded run must die (docs/jobs.md); this pump only ever loses freshness.
            await rt.board.gates(job, [...results]);
        } catch (e) {
            log(`job ${job.id}: could not report gate state, continuing: ${(e as Error).message}`);
        }
    };
    // The report must fit the board's 128 KiB body however many gates declared and however
    // verbose they were — JSON escaping can inflate bytes six-fold, so the raw budget per
    // gate shrinks as the list grows (16 gates still get 1 KiB of tail each).
    const perGate = Math.max(
        PER_GATE_OUTPUT_FLOOR_BYTES,
        Math.floor(GATES_REPORT_BUDGET_BYTES / gateSession.declared.length)
    );
    // A setup that failed in this claim's environment is retried by running the gates, never skipped
    // by serving them from an earlier pass: the reuse waits for a setup that succeeded.
    const content = job.setupFailure ? null : await contentOf(runCtx, treeAfter);
    const walk: GateWalk = { ...runCtx, treeAfter, content, results, perGate, report };
    // Ad-hoc admission is already closed and drained (verifyRun, before the completion tree is read),
    // so every ad-hoc run has landed in the record read here.
    let earlier = content === null ? null : await readGateRuns(runCtx);
    for (;;) {
        // Every declared gate is listed from the first report on: the ones not yet started read pending.
        results.length = 0;
        for (const gate of gateSession.declared) {
            results.push({ name: gate.name, status: 'pending', exitCode: null, output: null });
        }
        const verdict = await passOver(walk, earlier);
        if (verdict !== STALE_REUSE) return verdict;
        earlier = null;
    }
}

/** One walk over the declared gates: the context, the report list the board is told, and the report pump. */
interface GateWalk extends GatesRunCtx {
    treeAfter: string | null;
    /** The content key of `treeAfter` (issue #983): what a reused pass must have run on. Null: nothing is reused. */
    content: string | null;
    results: GateReport[];
    perGate: number;
    report: () => Promise<void>;
}

/** Whether the checkout still reads the tree the reused passes certified; an unreadable tree does not. Null: stood down. */
async function treeUnchanged(w: GateWalk): Promise<boolean | null> {
    const { state, gateSession, treeAfter, content } = w;
    const probing = gateSession.ledger.probe(AbortSignal.any([state.signal, AbortSignal.timeout(GATE_RUNS_READ_MS)]));
    const raced = await raceStep(
        state.signal,
        probing.then(
            (probe) =>
                probe.fingerprint !== null &&
                probe.fingerprint === treeAfter &&
                probe.content !== null &&
                probe.content === content,
            () => false
        )
    );
    return raced ? raced.value : null;
}

/**
 * The content key of the completion tree (issue #983), read once before the walk: a pass certifies
 * file contents, which a publish commit keeps while it moves the fingerprint. Taken only while the
 * checkout still reads `treeAfter`, the fingerprint the evidence binds to; null — nothing reused —
 * on any other read, a timeout or no completion tree at all.
 */
async function contentOf(ctx: GatesRunCtx, treeAfter: string | null): Promise<string | null> {
    const { gateSession, state } = ctx;
    if (treeAfter === null) return null;
    const probing = gateSession.ledger.probe(AbortSignal.any([state.signal, AbortSignal.timeout(GATE_RUNS_READ_MS)]));
    const raced = await raceStep(
        state.signal,
        probing.then(
            (probe) => (probe.fingerprint === treeAfter ? probe.content : null),
            () => null
        )
    );
    return raced?.value ?? null;
}

/** One declared gate executed and settled in the report: its failure, or `GATE_PASSED`; null when stood down. */
async function executeGate(
    w: GateWalk,
    gate: DeclaredGate,
    index: number
): Promise<GateFailure | null | typeof GATE_PASSED> {
    const { state, results, perGate, report } = w;
    results[index] = {
        name: gate.name,
        status: 'running',
        exitCode: null,
        output: null,
        startedAt: new Date().toISOString(),
    };
    await report();
    // Re-acquire, then run, under one catch: an environment that cannot be revived is a
    // gate that cannot run at all — the same failed-gate shape, never a crash of the run.
    // Raced against the stand-down: the re-acquire (an image pull, a cluster request) has no
    // timeout of its own, and the heartbeat keeps the lease while a Stop waits on it.
    const raced = await raceStep(state.signal, runOneGate(w, gate));
    const outcome = raced?.value?.run;
    // A null is the stand-down abandonment above; a stand-down DURING the gate cancelled it,
    // and a cancelled gate is never reported failed — `gate-failed` must not read it.
    if (!outcome || down(state)) return null;
    const { entry, text } = settledGate(gate, outcome, perGate);
    // Replace the gate's own entry — one entry per declared gate, always, so the list the
    // board stores IS the declared list at its current state.
    results[index] = { ...entry, executionId: raced!.value!.executionId };
    await report();
    if (entry.status === 'failed') {
        return { name: gate.name, exitCode: outcome.exitCode ?? REFUSED_TO_RUN_EXIT_CODE, output: text };
    }
    return GATE_PASSED;
}

/** The gate's eligible earlier pass, unless a gate of this walk already changed the checkout; null when stood down. */
async function reusableAfterWalk(
    w: GateWalk,
    gate: DeclaredGate,
    pool: GateRunRecord[] | null,
    executed: boolean
): Promise<{ reused: GateRunRecord | null; pool: GateRunRecord[] | null } | null> {
    const { gateSession, content } = w;
    const reused = reusableRun(pool, gate, {
        identity: gateSession.ledger.identity(gate),
        tree: content,
        runClaimSeq: gateSession.runClaimSeq,
    });
    if (!reused || !executed) return { reused, pool };
    const unchanged = await treeUnchanged(w);
    if (unchanged === null) return null;
    // A gate of this walk changed the checkout: nothing reused from here on, this one runs.
    return unchanged ? { reused, pool } : { reused: null, pool: null };
}

/**
 * One walk over the declared gates, reusing a pass from `earlier` where one is eligible. Once a gate of
 * this walk has run, the tree is read again: a reuse is certified for `treeAfter` only while the
 * checkout still is `treeAfter`. A gate that edited it (a formatter) voids the reuse of every later
 * gate, and one already taken before it: the walk is then answered `STALE_REUSE`, to run again without any.
 */
async function passOver(
    w: GateWalk,
    earlier: GateRunRecord[] | null
): Promise<GateFailure | null | typeof STALE_REUSE> {
    const { rt, job, state, gateSession, results, report } = w;
    let pool = earlier;
    let executed = false;
    let reusedAny = false;
    for (const [index, gate] of gateSession.declared.entries()) {
        // The lease can be reclaimed — or the task stopped or removed — mid-gates. Everything
        // after that is dead work, and the attempt settles without a gate verdict.
        if (down(state)) return null;
        const eligible = await reusableAfterWalk(w, gate, pool, executed);
        if (!eligible) return null;
        pool = eligible.pool;
        const { reused } = eligible;
        if (reused) {
            reusedAny = true;
            rt.log(`job ${job.id}: gate ${gate.name} reused from execution ${reused.executionId}, not run again`);
            results[index] = reusedReport(gate, reused);
            await report();
            continue;
        }
        executed = true;
        const ran = await executeGate(w, gate, index);
        if (ran !== GATE_PASSED) return ran;
    }
    if (executed && reusedAny) {
        const unchanged = await treeUnchanged(w);
        if (unchanged === null) return null;
        if (!unchanged) return STALE_REUSE;
    }
    // Every gate ran after its setup succeeded: a failed pre-agent setup was fixed.
    job.setupFailure = null;
    return null;
}

/**
 * The run's gate record, read once before the declared gates (issue #983): null — reuse nothing, run
 * every gate — for a tree that could not be read (nothing can match it), a read the board did not
 * answer in full, one that timed out, or a stand-down that cut it short. Never an empty record by
 * default: an unconfirmed read is not an answer.
 */
async function readGateRuns(ctx: GatesRunCtx): Promise<GateRunRecord[] | null> {
    const { rt, job, gateSession, state } = ctx;
    const signal = AbortSignal.any([state.signal, AbortSignal.timeout(GATE_RUNS_READ_MS)]);
    const raced = await raceStep(
        state.signal,
        rt.board.gateRuns(job, gateSession.runClaimSeq, signal).catch(() => null)
    );
    return raced?.value ?? null;
}

/**
 * The end-of-run pass of a checkout with no gate to run but a failed setup: setup again, through
 * the gate transport, so a failure lands as the same setup-failed gate failure a gate would report.
 */
async function retryFailedSetup(ctx: GatesRunCtx): Promise<GateFailure | null> {
    const { rt, job, gateSession, state, signal } = ctx;
    const manager = rt.gates?.manager;
    if (!manager) return null;
    const retried = gateEnvNow(rt, job, 'the setup retry')
        .then((envBody) => manager.acquire(gateSession.key, gateSession.image, envBody, { job }))
        .then(() => (down(state) ? null : manager.runSetup(gateSession.key, { signal })))
        .catch(refusedToRun);
    const outcome = (await raceStep(state.signal, retried))?.value;
    if (!outcome || down(state)) return null;
    if (outcome.exitCode === 0) {
        job.setupFailure = null;
        return null;
    }
    const exitCode = outcome.exitCode ?? REFUSED_TO_RUN_EXIT_CODE;
    return { name: 'environment.setup', exitCode, output: `${SETUP_FAILED_PREFIX}${outcome.output}` };
}

/**
 * The attempt's dead services, asked right before the declared gates (issue #423). Best-effort:
 * a probe that cannot read the fleet costs the short-circuit, never the gates — they run, and a
 * service that really died still fails them.
 */
export async function probeDeadServices(rt: LoopRuntime, job: BoardJob): Promise<DeadService[]> {
    try {
        return await rt.runner.deadServices(job);
    } catch (e) {
        rt.log(`job ${job.id}: could not read the service fleet, running the gates: ${(e as Error).message}`);
        return [];
    }
}

/** One gate session's teardown: the checkout is forgotten, the token dies. */
export function releaseGateSession(rt: LoopRuntime, session: GateSession, job: BoardJob): void {
    rt.gates?.server.unregister(session.token);
    rt.gates?.manager.release(session.key, job);
}

/**
 * The gates phase of a task confirmed to have produced no change (issue #1020), logged; null when it
 * did, or when the read failed, timed out or was aborted — inconclusive, so the gates run.
 */
export async function noChangeSkip(ctx: { rt: LoopRuntime; job: BoardJob; state: { signal: AbortSignal } }) {
    const { rt, job, state } = ctx;
    const raced = await raceStep(
        state.signal,
        rt.runner.probeNoChange(job, state.signal).catch(() => false)
    );
    if (raced?.value !== true) return null;
    const why = 'the task produced no change (no diff against its base)';
    rt.log(`job ${job.id}: gates skipped — ${why}`);
    return { failure: null, deadServices: [], gatesSkipped: why, noChange: true, recoveredServices: [], reports: [] };
}
