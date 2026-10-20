import { randomUUID } from 'node:crypto';
import type { BoardJob, DeclaredGate } from './board.js';
import { CONTROL_TOKEN_ENV, CONTROL_URL_ENV, gateEnvBody, setupTimeoutMs } from './claim.js';
import { tailBytes, type DeadService } from './runner.js';
import { stepLost } from './step-control.js';
import { declaredTimeoutMs, type GateRun } from './gates.js';
import { clearPendingQuestions, down, raceStep } from './loop-attempt.js';
import { SUPERVISOR_ENV } from './supervisor-contract.js';
import type { JobState } from './loop-attempt.js';
import { askGithubToken } from './loop-github.js';
import { createPublishRelay } from './loop-publish.js';
import { createQuestionRelay } from './loop-questions.js';
import { createReviewRelay } from './loop-review.js';
import { attachTranscriptExport } from './loop-export.js';
import type { LoopRuntime } from './loop-types.js';
import { worktreeRelDir } from './publish.js';

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
}

export interface GateFailure {
    name: string;
    exitCode: number;
    output: string;
}

/** What one gate looks like on the board, at one moment. */
type GateReport = {
    name: string;
    status: 'running' | 'passed' | 'failed';
    exitCode: number | null;
    output: string | null;
};

/**
 * Ensures the job's gate environment, registers its ad-hoc token and runs `environment.setup` in
 * it (issue #733), or answers null for a job that declares neither gates nor setup. The token and
 * URL ride the claim's env into the runner's env file — appended after the claim's own lines,
 * where docker's last-wins rule keeps a member-scoped `BELLOWS_GATE_TOKEN` from minting itself a
 * gate credential.
 */
export async function beginGates(rt: LoopRuntime, job: BoardJob, state: JobState): Promise<GateSession | null> {
    const { gates } = rt;
    // A checkout that declares only `setup` still gets the environment: setup runs in it before
    // the agent starts (issue #733).
    if (!job.gates || (!job.gates.gates.length && !job.gates.setup)) return null;
    if (!gates) {
        // Declared gates with no gate environment were refused by the re-read; only setup is left.
        rt.log(`job ${job.id}: environment.setup skipped — this driver has no gate environment configured`);
        return null;
    }
    // The gates run in the task worktree (issue #35) — the tree the run edits — so the
    // environment is keyed by the worktree path, `<org>/<uuid>/.worktrees/<root id>`. A job
    // that names no repository has no worktree and no gates either.
    const key = worktreeRelDir(job);
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
        const port = await gates.server.listen();
        const token = randomUUID();
        gates.server.register(token, {
            key,
            image: job.gates.image,
            envBody,
            job,
            gates: job.gates.gates,
            freshEnv: () => gateEnvNow(rt, job, 'a gate run'),
            // The agent's ad-hoc gate found the supervisor lost: the attempt's, once its run is over.
            onInfraLoss: (reason) => {
                state.gateLoss ??= reason;
            },
        });
        // Beside `env`, not inside it: the reserved-name filter keeps a member-configured
        // BELLOWS_GATE_* out of the claim lines, and these are the driver's own minted values.
        // The run-control pair, minted earlier (`openRunControl`, before the sync), stays beside it.
        job.gateEnv = {
            ...job.gateEnv,
            BELLOWS_GATE_URL: gates.advertiseUrl(port),
            BELLOWS_GATE_TOKEN: token,
        };
        await runEnvironmentSetup(rt, job, key, state);
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
 * the supervised steps; the exporter's, beside it in `job.supervisorEnv`, opens only the transcript
 * export; the agent's, advertised beside the gate pair (`job.gateEnv`), opens only the publish and
 * review routes. Best-effort — a driver whose endpoint cannot bind keeps today's immediate-kill
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
        gates.server.grantAgent(token, agentToken);
        gates.server.grantExporter(token, exporterToken);
        attachTranscriptExport({ rt, job, state }, token);
        const url = gates.advertiseUrl(port);
        job.gateEnv = { ...job.gateEnv, [CONTROL_URL_ENV]: url, [CONTROL_TOKEN_ENV]: agentToken };
        job.supervisorEnv = {
            [SUPERVISOR_ENV.controlUrl]: url,
            [SUPERVISOR_ENV.controlToken]: token,
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
const gateEnvNow = async (rt: LoopRuntime, job: BoardJob, what: string): Promise<string> => {
    // `beginGates` adds the gate server's own pair to `job.gateEnv` for the agent; a gate run never
    // gets it, or a gate could call `/run` on its own checkout and wait behind itself.
    const gateEnv = Object.fromEntries(
        Object.entries(job.gateEnv ?? {}).filter(([name]) => !GATE_SERVER_PAIR.includes(name))
    );
    return gateEnvBody({ ...job, gateEnv }, await askGithubToken(rt, job, what));
};

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

/** One declared gate's re-acquire-then-run outcome, folding a re-acquire failure into a failed gate. */
async function runOneGate(ctx: GatesRunCtx, gate: DeclaredGate): Promise<GateRun | null> {
    const { rt, job, gateSession, state, signal } = ctx;
    const { gates } = rt;
    if (!gates) return null;
    return gateEnvNow(rt, job, `gate ${gate.name}`)
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
            });
        })
        .catch(refusedToRun);
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
 * Runs every declared gate in order, reporting each state change to the board as it happens.
 * The report REPLACES the stored list — every report carries the whole list so the task view
 * always shows all gates at their current state, never a summary that arrived out of order.
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
    state: JobState
): Promise<GateFailure | null> {
    const { gates, log } = rt;
    if (!gates) return null;
    // The attempt's own signal is the gate transport's abort: a stand-down cancels the gate in
    // flight, not only the ones after it, and no second controller exists to keep in step
    // (issue #472).
    const runCtx: GatesRunCtx = { rt, job, gateSession, state, signal: state.signal };
    // No declared gate to retry a failed setup before: the pass is that retry alone.
    if (gateSession.declared.length === 0) return retryFailedSetup(runCtx);
    const results: GateReport[] = [];
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
    for (const gate of gateSession.declared) {
        // The lease can be reclaimed — or the task stopped or removed — mid-gates. Everything
        // after that is dead work, and the attempt settles without a gate verdict.
        if (down(state)) return null;
        results.push({ name: gate.name, status: 'running', exitCode: null, output: null });
        await report();
        // Re-acquire, then run, under one catch: an environment that cannot be revived is a
        // gate that cannot run at all — the same failed-gate shape, never a crash of the run.
        // Raced against the stand-down: the re-acquire (an image pull, a cluster request) has no
        // timeout of its own, and the heartbeat keeps the lease while a Stop waits on it.
        const raced = await raceStep(state.signal, runOneGate(runCtx, gate));
        const outcome = raced?.value;
        // A null is the stand-down abandonment above; a stand-down DURING the gate cancelled it,
        // and a cancelled gate is never reported failed — `gate-failed` must not read it.
        if (!outcome || down(state)) return null;
        const { entry, text } = settledGate(gate, outcome, perGate);
        // Replace the gate's own entry — one entry per declared gate, always, so the list the
        // board stores IS the declared list at its current state.
        results[results.length - 1] = entry;
        await report();
        if (entry.status === 'failed') {
            return { name: gate.name, exitCode: outcome.exitCode ?? REFUSED_TO_RUN_EXIT_CODE, output: text };
        }
    }
    // Every gate ran after its setup succeeded: a failed pre-agent setup was fixed.
    job.setupFailure = null;
    return null;
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
