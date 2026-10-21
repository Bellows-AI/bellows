import type { BoardJob, VerdictEvidence } from './board.js';
import { uploadRunArtifacts } from './artifact-upload.js';
import { repoCacheProblem } from './claim.js';
import { pickSession } from './runner-plan.js';
import { evidenceDecision, evidencePolicyActive, type GatesOutcome, gatesEvidenceOf } from './evidence-policy.js';
import type { DeadService, RunOutcome, RunSession } from './runner.js';
import { adoptStep, recordAdopted } from './loop-adopt.js';
import { askGithubToken, checkoutToken } from './loop-github.js';
import { preHelperStep, runPostHelperPhase } from './loop-helpers.js';
import type { GateFailure, GateSession } from './loop-gates.js';
import { beginGates, openRunControl, probeDeadServices, runDeclaredGates, sizeGateForVerify } from './loop-gates.js';
import { drainTranscriptExport } from './loop-export.js';
import { lostOf, logRefusal, transition, transitionLine } from './loop-phase.js';
import { heartbeat, newJobState, raceStep, registerLive, stopIfDraining, watchOutput } from './loop-attempt.js';
import { attemptQuiesce, abandonOnHandover, end, endIfDown } from './loop-conclusion.js';
import type { GateRunNote } from './timeout-note.js';
import {
    faultHalt,
    syncFailureHalt,
    handBackFence,
    handOverConflict,
    interruptDecision,
    releaseAbandonedSync,
    setupDecision,
    syncThrewHalt,
    thrownRunDecision,
    unreportedDecision,
} from './loop-fence.js';
import type { AdoptedRecord, AttemptCtx, LoopRuntime, SetupConclusion } from './loop-types.js';
import { STOOD_DOWN } from './loop-types.js';
import type { HelperFailureReport } from './helpers.js';
import type { PublishResult, SyncResult } from './publish.js';
import { agentFaults, gatesEligible, ledgerOf, postHelperSkipWhy, skipWhyOf } from './loop-ledger.js';
import { publishBranch, publishModeOf, publishOptionsOf, report, reportFinish } from './loop-verdict.js';
import { OPENCODE } from './executors.js';
import { masterPromptRefusalReason } from './master-prompt.js';
import { AGENTLESS_OUTCOME, isAgentless } from './loop-agentless.js';
import { awaitSyncTurn } from './sync-queue.js';
import { stepLost } from './step-control.js';
import { restartDeadServices, servicesLost, startServicesStep } from './loop-services.js';
import { servicePlanRefusal } from './services.js';

/** How the attempt's log line names the session it runs under. */
const sessionNote = (session: RunSession | null): string =>
    session
        ? `${session.resume ? 'resuming' : 'starting as'} session ${session.id}`
        : 'starting (headless opencode run: no session id)';

/**
 * Reported while the lease is still live, BEFORE the park or the verdict — a follow-up can only
 * be asked for once the task is finished, and it resumes exactly this. A 'lost' verdict is not
 * acted on: the heartbeat is what kills a superseded run, and losing the link is not losing the
 * job. An opencode run ALWAYS leaves a session, so an empty scrape is the readout having failed
 * every try — said out loud, because the cost is a task that can never take a follow-up, and a
 * verdict without its finish reason or context. The stopped path calls this too (issue #152): a
 * stop's park lands the row terminal, and a session reported after it is refused — the stopped
 * task would settle sessionless with nothing to follow up.
 */
async function reportScrapedSession(
    rt: LoopRuntime,
    job: BoardJob,
    executorType: BoardJob['executorType'],
    outcome: RunOutcome
): Promise<void> {
    const { board, log } = rt;
    if (outcome.sessionId) {
        try {
            await board.session(job, outcome.sessionId);
            log(`job ${job.id}: session ${outcome.sessionId}`);
        } catch (e) {
            log(`job ${job.id}: could not report the session, continuing: ${(e as Error).message}`);
        }
    } else if (executorType === OPENCODE) {
        log(
            `job ${job.id}: the session readout came up empty (${outcome.readoutError ?? 'no session in the database'}) — ` +
                'no session to follow up, finish reason and context stats unread'
        );
    }
}

/**
 * The reclaim barrier (see `reclaims`): an in-flight removal of THIS thread's tree is waited out
 * before the sync — the first touch of the task worktree — so a follow-up claimed while its
 * thread's tree was being deleted never syncs against, or resurrects work on top of, a tree
 * mid-removal.
 */
async function waitReclaimBarrier(ctx: AttemptCtx): Promise<SetupConclusion | null> {
    const { rt, job, state } = ctx;
    const inflight = rt.reclaims.get(job.rootJobId ?? job.id);
    return inflight && (await raceStep(state.signal, inflight)) === null ? STOOD_DOWN : null;
}

/** Syncs the task worktree with the remote default (or restores it), racing the stand-down. */
async function syncCheckoutStep(ctx: AttemptCtx): Promise<SetupConclusion | null> {
    const { rt, job, state } = ctx;
    const { runner } = rt;
    // An adopted run's tree is its result, and a taken-over run is still writing it: nothing rewrites it.
    if (ctx.adopted || ctx.takeover) return null;
    const turn = await awaitSyncTurn(ctx);
    if (turn === STOOD_DOWN || 'halt' in turn) return turn;
    const githubToken = await checkoutToken(rt, job, turn);
    const syncing = runner.syncCheckout(job, state.signal, ctx.session, githubToken);
    // The turn is held until the sync's writes are over (`settled`), however the sync answered.
    turn.release(syncing.then((synced) => synced.settled).catch(() => {}));
    let syncedOut: { value: SyncResult } | null;
    try {
        syncedOut = await raceStep(state.signal, syncing);
    } catch (e) {
        return syncThrewHalt(e);
    }
    if (syncedOut === null) {
        // The abandoned sync owns the claim until it answers, and nothing this attempt settles can
        // release one it never took — so it hands back its own when it lands.
        releaseAbandonedSync(rt, job, syncing);
        return STOOD_DOWN;
    }
    const synced = syncedOut.value;
    // An ok sync holds the checkout (kubernetes's claim) with no run yet to release it, so the
    // attempt holds it from here — even when a stand-down landed as the sync finished, in which
    // case the stand-down fence is what gives it back. A failed sync released its own.
    if (synced.ok) {
        ctx.fenced = true;
        ctx.treeBefore = synced.fingerprint ?? null;
        handOverConflict(job, synced);
        return null;
    }
    return syncFailureHalt(synced);
}

/**
 * Checks the claim's resolved gates against this driver, and refuses the job when they declare a
 * package cache the driver will not set, or gates it cannot run. The plan itself was resolved at
 * the claim, at one revision; nothing is re-read after the sync.
 */
async function checkPlanStep(ctx: AttemptCtx): Promise<SetupConclusion | null> {
    const { rt, job } = ctx;
    // The declaration may name a package cache the driver will not set (issue #734).
    const cacheProblem = repoCacheProblem(job);
    if (cacheProblem) {
        return faultHalt(
            'its declared package cache is refused, failing',
            `This job's .bellows.yaml declares a gate environment this driver will not run: ${cacheProblem}`,
            'config'
        );
    }

    if (job.gates?.gates?.length && !rt.gates) {
        const why = 'this driver was started with no gate environment configured';
        return faultHalt(
            'declares gates this driver cannot run, failing',
            `This job declares verification gates in .bellows.yaml, and ${why}. Re-queue it against a driver built with the GATE_* configuration set.`,
            'runner_error'
        );
    }
    return null;
}

/**
 * Starts the job's gate environment, or answers null for a job that declares none. The last setup
 * step, and the only one with an answer of its own: the session to run the gates with, or the
 * conclusion that ends the attempt here.
 */
async function acquireGateSession(ctx: AttemptCtx): Promise<GateSession | null | SetupConclusion> {
    const { rt, job, state } = ctx;
    try {
        const gateOut = await raceStep(state.signal, beginGates(rt, job, state, { takeover: Boolean(ctx.takeover) }));
        return gateOut === null ? STOOD_DOWN : gateOut.value;
    } catch (e) {
        // The setup's supervisor was lost (issue #773): the attempt's loss, never a config verdict.
        if (stepLost(e)) return { halt: 'interrupt', reason: gateLossReason(e) };
        return faultHalt(
            `gate environment failed, failing with a reason: ${(e as Error).message}`,
            `The gate environment declared in .bellows.yaml could not be started: ${(e as Error).message}`,
            'runner_error'
        );
    }
}

/** Why a gate or setup whose supervisor was lost interrupts its attempt (issue #773). */
const gateLossReason = (e: unknown): string =>
    `infrastructure loss: the task supervisor running the gates was lost (${(e as Error).message})`;

/** One setup step: `null` to continue, or the conclusion that ends the attempt here. */
type SetupStep = (ctx: AttemptCtx) => Promise<SetupConclusion | AdoptedRecord | null>;

/** The steps of the setup phase, in order — the reclaim barrier and the sync before anything reads the tree. */
const setupSteps: readonly SetupStep[] = [
    waitReclaimBarrier,
    adoptStep,
    syncCheckoutStep,
    checkPlanStep,
    // An adopted or taken-over run's pre-helpers ran before it did, and its services are already up.
    (ctx) => (ctx.adopted || ctx.takeover ? Promise.resolve(null) : preHelperStep(ctx)),
    (ctx) => (ctx.takeover ? Promise.resolve(null) : startServicesStep(ctx)),
];

const isRecord = (answer: SetupConclusion | AdoptedRecord | null): answer is AdoptedRecord =>
    typeof answer === 'object' && answer !== null && 'record' in answer;

/** Whether a step's answer ends the attempt, rather than answering the gate session to run with. */
const isConclusion = (answer: GateSession | null | SetupConclusion): answer is SetupConclusion =>
    answer === STOOD_DOWN || (answer !== null && 'halt' in answer);

/**
 * Ends the attempt on the one conclusion it reached. Every exit from setup goes through here, which is
 * what makes a new refusal safe (issue #472): a stand-down parks the attempt, and wins over whatever
 * the step concluded — the attempt is down whatever the step found — while a `SetupHalt` is decided
 * by `setupDecision` and landed by `end`. Answers whether the attempt is finished here; a step that
 * answers `null` with the attempt still up is not.
 */
async function conclude(ctx: AttemptCtx, conclusion: SetupConclusion | null): Promise<boolean> {
    if (await endIfDown(ctx, 'setup')) return true;
    if (conclusion === null) return false;
    if (conclusion !== STOOD_DOWN) await end(ctx, setupDecision(conclusion));
    return true;
}

/**
 * The setup phase of one attempt: the reclaim barrier, the checkout sync, the plan check and
 * its refusals, the job's declared PRE block-helper steps, and the gate environment. Answers the
 * gate session to run with (null when the job declares none), or `STOOD_DOWN` when the attempt is
 * finished here — settled, released and reported by this function alone, so the caller must not
 * fall through to the run.
 */
async function runPhases(ctx: AttemptCtx): Promise<GateSession | null | typeof STOOD_DOWN> {
    // Every attempt gets a control endpoint (issue #442), minted before anything is created so the
    // env the task group is specced with already names it — and so the supervisor has its channel
    // for the sync, the first step it serves (issue #771): agent-less and adopted attempts included.
    await openRunControl(ctx.rt, ctx.job, ctx.state);
    for (const step of setupSteps) {
        const answer = await step(ctx);
        // A record is performed, not an ending: the stand-down read still follows it.
        if (isRecord(answer)) await recordAdopted(ctx, answer);
        if (await conclude(ctx, isRecord(answer) ? null : answer)) return STOOD_DOWN;
    }
    const booted = await acquireGateSession(ctx);
    const session = isConclusion(booted) ? null : booted;
    // A session the boot handed back is released by `end` if the attempt ended meanwhile.
    if (session) ctx.gateSession = session;
    if (await conclude(ctx, isConclusion(booted) ? booted : null)) return STOOD_DOWN;
    ctx.setupDone = true;
    return session;
}

/** A short-circuit outcome of the run phase: settled with nothing left for the caller to do. */
type RunPhaseDone = { done: true };

/** The run phase's ordinary conclusion: what to report, and the gate failure (if any) behind it. */
type RunPhaseResult = {
    done: false;
    outcome: RunOutcome;
    failure: GateFailure | null;
    /** The declared services found dead before the gates — which were skipped for them. */
    deadServices: DeadService[];
    /** The services found dead before the gates and restarted for them (issue #560). */
    recoveredServices: DeadService[];
    /**
     * When `runner.run` resolved — the moment the run ended, and the timestamp the timeout
     * note's active/idle verdict is measured at. The verdict builds later: the declared gates,
     * the post-helpers and the session scrape can each run minutes after a kill, and aging the
     * last output from VERDICT time would report a run that was streaming when it died as idle.
     */
    endedAt: number;
    /** Why the declared gates were skipped, or null. */
    gatesSkipped: string | null;
    /** Whether the failed gate's tree differs from the synced one; null when unmeasured. */
    treeChanged: boolean | null;
    /** The revision-bound evidence record; null when no policy is configured. */
    evidence: VerdictEvidence | null;
};

/** What one run needs beyond its `AttemptCtx`: the session, its gates, and its I/O plumbing. */
interface RunInputs {
    session: RunSession | null;
    gateSession: GateSession | null;
    executorType: BoardJob['executorType'];
    /** The output pump: `push` streams the live tail, `flush` the run's final one ahead of a park with no verdict. */
    pump: ReturnType<typeof watchOutput>;
}

/** What an agent run leaves behind: its scraped session and its artifacts. An agent-less node leaves neither. */
async function reportRunTail(
    ctx: AttemptCtx,
    executorType: BoardJob['executorType'],
    outcome: RunOutcome
): Promise<void> {
    const { rt, job } = ctx;
    if (isAgentless(job)) return;
    // A spool-cap stop is stamped on the outcome the session report reads.
    drainTranscriptExport(ctx, outcome);
    await reportScrapedSession(rt, job, executorType, outcome);
    // Never throws and never reaches the verdict: a failed upload only leaves a stream without a
    // `complete` manifest.
    await uploadRunArtifacts({ board: rt.board, job, executorType, outcome }, rt);
}

/**
 * The spawn: answers the run's outcome, or null when a stand-down landed first (already settled).
 * An agent-less node (issue #503) launches nothing — it answers a clean run for the gates and the
 * publish to follow, after handing back the claim the sync took, since no runner comes to release it.
 */
async function launchRun(
    ctx: AttemptCtx,
    session: RunSession | null,
    onOutput: (tail: string) => void
): Promise<RunOutcome | null> {
    const { rt, job, state } = ctx;
    const agentless = isAgentless(job);
    // A Stop, lost lease or Remove that landed during setup, before the spawn: nothing runs, and
    // the stand-down fence releases a claim the runner never took.
    if (await endIfDown(ctx, 'setup')) return null;
    if (agentless) {
        // The services the gates test against were started by the setup phase.
        await handBackFence(ctx);
        return AGENTLESS_OUTCOME;
    }
    // The adopted run already happened: its outcome is this attempt's, and nothing launches.
    if (ctx.adopted) {
        await handBackFence(ctx);
        // Paced like a launched attempt for the gates and publish that follow.
        state.launched = true;
        transition(state, 'launched');
        return ctx.adopted.outcome;
    }
    // Reported here, not at attempt start: a setup that concludes the job starts no session, and a
    // session id reported for one would name a conversation that never existed. A taken-over run's
    // session was reported by the claim that started it.
    if (!ctx.takeover) await reportNewSession(rt, job, session);
    state.launched = true;
    transition(state, 'launched');
    // The launch hands the checkout claim to the runner, whose group's confirmed end releases it.
    ctx.fenced = false;

    state.running = true;
    const run = rt.runner.run(job, session, onOutput).finally(() => {
        state.running = false;
    });
    const outcome = await abandonOnHandover(state, run, () => rt.runner.abandon(job));
    if (outcome === null) await endIfDown(ctx, 'its run');
    return outcome;
}

/** The run itself: spawn, and resolve to what to report (or nothing). */
async function runAttempt(ctx: AttemptCtx, inputs: RunInputs): Promise<RunPhaseDone | RunPhaseResult> {
    const { state } = ctx;
    const { session, gateSession, executorType, pump } = inputs;
    const outcome = await launchRun(ctx, session, pump.push);
    if (outcome === null) return { done: true };
    // The run's end, stamped HERE — not at verdict time: the gates, helpers and session scrape
    // below can run minutes after a kill, and the timeout note's active/idle verdict must
    // describe the run as it ended, not as it was reported.
    const endedAt = Date.now();

    // A draining attempt settles as stopped even after a clean exit: the agent stopped because it
    // was asked to, so no gates, helpers, publish or `complete` follow (issue #442). A stop after
    // the run still reports the session and uploads the artifacts BEFORE the park.
    stopIfDraining(state);
    const lastWords = () => pump.flush(outcome.output).then(() => reportRunTail(ctx, executorType, outcome));
    if (await endIfDown(ctx, 'its run', lastWords)) return { done: true };

    /*
     * The runner, not this loop, knows what a refused start looks like on its platform, and
     * stamps `started: false` for it. Saying nothing here would rerun the job until attempts
     * run out and retire it dead, blaming the command for infrastructure.
     */
    if (await concludeRunEnd(ctx, outcome)) return { done: true };

    // The artifacts upload HERE, before the gates, so a gate suite that runs minutes cannot push
    // the upload past the run's end. The board authorizes it by claim sequence, so even a reclaim
    // would not refuse it. Best-effort throughout; a failed upload leaves the stream without a
    // complete manifest, never a failed run.
    await reportRunTail(ctx, executorType, outcome);
    await clearUnusedSession(ctx, session, outcome);

    const verified = await verifyRun(ctx, gateSession, outcome);
    if (verified === STOOD_DOWN) return { done: true };
    return { done: false, outcome, ...verified, endedAt };
}

/**
 * The session minted and reported before the spawn never ran — no transcript exists under it, so a
 * follow-up resuming it would find no conversation. A resumed session is the parent's and stays.
 */
async function clearUnusedSession(ctx: AttemptCtx, session: RunSession | null, outcome: RunOutcome): Promise<void> {
    const { rt, job } = ctx;
    if (!outcome.refused || !session || session.resume || ctx.adopted) return;
    await rt.board
        .session(job, null)
        .catch((e: Error) => rt.log(`job ${job.id}: could not clear the unused session: ${e.message}`));
}

/** What verifying a run found beyond the gates phase itself. */
type VerifiedRun = GatesPhase & Pick<RunPhaseResult, 'treeChanged' | 'evidence'>;

/**
/**
 * Runs the declared gates over a finished run and gathers what the verdict is built from, answering
 * STOOD_DOWN when a stand-down landed at any of the three points between.
 */
async function verifyRun(
    ctx: AttemptCtx,
    gateSession: GateSession | null,
    outcome: RunOutcome
): Promise<VerifiedRun | typeof STOOD_DOWN> {
    const { job, state } = ctx;
    /*
     * The gates run HERE: after the agent has finished talking and before the verdict, with the
     * heartbeat still beating — settle() has deliberately NOT been called yet, because a test
     * suite can take minutes and it must not outrun the lease it runs under. A run that did not
     * finish cleanly skips them: a gate over work that never happened fires gate-fix for nothing.
     * A session whose gates are all on demand has no pass: its evidence reads `none`, never `passed`.
     */
    const gating = gateSession?.endPass && !outcome.refused && !lostOf(state) ? gateSession : null;
    // The tree is read BEFORE the gates: a gate that writes a non-ignored artifact (a timestamped
    // report) must not read as the agent's progress. Under an evidence policy it is read gated or
    // not: it is the revision the evidence is bound to.
    const treeAfter = gating || evidencePolicyActive(job) ? await probeTreeNow(ctx) : null;
    if (await endIfDown(ctx, 'its gates')) return STOOD_DOWN;
    const gated = await gatesOrLoss(ctx, gating, outcome);
    if (gated === STOOD_DOWN) return STOOD_DOWN;
    if (await endIfDown(ctx, 'its gates')) return STOOD_DOWN;
    return {
        ...gated,
        treeChanged: treeChangedOf(ctx, gated, treeAfter),
        evidence: evidenceOf(ctx, gating, gated, treeAfter),
    };
}

/**
 * Whether the failed gate's tree differs from the synced one; null when unmeasured. A cancelled
 * gate answers no failure, so a stand-down during the gates lands here too.
 */
function treeChangedOf(ctx: AttemptCtx, gated: GatesPhase, treeAfter: string | null): boolean | null {
    return gated.failure && ctx.treeBefore !== null && treeAfter !== null ? treeAfter !== ctx.treeBefore : null;
}

/** The revision-bound evidence record of a verified run; null when no policy is configured. */
function evidenceOf(
    ctx: AttemptCtx,
    gating: GateSession | null,
    gated: GatesPhase,
    treeAfter: string | null
): VerdictEvidence | null {
    if (!evidencePolicyActive(ctx.job)) return null;
    return { treeBefore: ctx.treeBefore, treeAfter, gates: gatesOutcomeOf(Boolean(gating?.declared.length), gated) };
}
/** How the declared gates ended for the evidence record: `none` when none were declared to run. */
function gatesOutcomeOf(declared: boolean, gated: GatesPhase): GatesOutcome {
    if (!declared) return 'none';
    if (gated.gatesSkipped !== null || gated.deadServices.length > 0) return 'incomplete';
    return gated.failure ? 'failed' : 'passed';
}

/** What the gates phase of one attempt found: the failed gate, the dead services, or why it skipped. */
interface GatesPhase {
    failure: GateFailure | null;
    deadServices: DeadService[];
    gatesSkipped: string | null;
    /** The services found dead before the gates and restarted for them (issue #560): noted, not faults. */
    recoveredServices: DeadService[];
}

/**
 * The run's end with no verdict of its own, answering whether the attempt was concluded here: an
 * ad-hoc gate that found the supervisor lost while the agent ran (issue #773) interrupts it, and a
 * run the platform refused or took away is concluded by `unreportedDecision`.
 */
async function concludeRunEnd(ctx: AttemptCtx, outcome: RunOutcome): Promise<boolean> {
    const { gateLoss } = ctx.state;
    const decision =
        gateLoss === null
            ? unreportedDecision(outcome)
            : interruptDecision(`infrastructure loss: ${gateLoss}`, outcome.exitCode);
    if (decision === null) return false;
    await end(ctx, decision);
    return true;
}

/**
 * The gates phase — none without a session to run — or `STOOD_DOWN` once a gate, setup or service
 * restart whose supervisor was lost, or whose pod could not be read (issue #773), interrupted the
 * attempt here: no gate verdict lands for it.
 */
async function gatesOrLoss(
    ctx: AttemptCtx,
    gateSession: GateSession | null,
    outcome: RunOutcome
): Promise<GatesPhase | typeof STOOD_DOWN> {
    if (!gateSession) return { failure: null, deadServices: [], gatesSkipped: null, recoveredServices: [] };
    try {
        return await runGatesPhase(ctx, gateSession, outcome);
    } catch (e) {
        if (!servicesLost(e)) throw e;
        const reason = stepLost(e) ? gateLossReason(e) : `infrastructure loss: ${(e as Error).message}`;
        await end(ctx, interruptDecision(reason, null));
        return STOOD_DOWN;
    }
}

/** The declared gates, unless the run did not finish cleanly or a declared service is dead. */
async function runGatesPhase(ctx: AttemptCtx, gateSession: GateSession, outcome: RunOutcome): Promise<GatesPhase> {
    const { rt, job, state } = ctx;
    const agent = agentFaults(outcome);
    const gatesSkipped = gatesEligible(agent) ? null : skipWhyOf(agent);
    if (gatesSkipped !== null) {
        rt.log(`job ${job.id}: gates skipped — ${gatesSkipped}`);
        // The services' faults are the run's too, gates or not: a blocked agent is the one that
        // most needs to be told its environment was dead (issue #487).
        return {
            failure: null,
            deadServices: await probeDeadServices(rt, job),
            gatesSkipped,
            recoveredServices: [],
        };
    }
    // A gate against a dead service fails on an environment the agent cannot fix, and a
    // failed gate is what the workflow's gate-fix edge spends a round on (issue #423). The
    // services are stateless fixtures, so a dead one is restarted first; only a restart that
    // cannot bring the fleet back is the run's fault (issue #560).
    await sizeGateForVerify(rt, job);
    const deadBefore = await probeDeadServices(rt, job);
    let recoveredServices: DeadService[] = [];
    if (deadBefore.length > 0) {
        const restartFailure = await restartDeadServices(rt, job, state.signal, deadBefore);
        // A stand-down during the restart runs no gates; the caller's fence settles the attempt.
        if (restartFailure === STOOD_DOWN)
            return { failure: null, deadServices: [], gatesSkipped: null, recoveredServices };
        if (restartFailure !== null) {
            const deadServices = deadBefore.map((dead) => ({ ...dead, restartFailure }));
            return { failure: null, deadServices, gatesSkipped: null, recoveredServices };
        }
        recoveredServices = deadBefore;
    }
    const failure = await runDeclaredGates(rt, job, gateSession, state);
    // A service OOM-killed by the suite fails the gate for a reason the agent cannot fix: re-probe.
    const deadAfter = failure ? await probeDeadServices(rt, job) : [];
    return { failure, deadServices: deadAfter, gatesSkipped: null, recoveredServices };
}

/** The post-helpers' failure, or `STOOD_DOWN` once they ended the attempt: it is down, or a lost supervisor interrupted it. */
async function endingPostHelpers(
    ctx: AttemptCtx,
    skipReason: string | null
): Promise<HelperFailureReport | null | typeof STOOD_DOWN> {
    const found = await runPostHelperPhase(ctx, skipReason);
    if (await endIfDown(ctx, 'its post-helpers')) return STOOD_DOWN;
    if (found === null || found === STOOD_DOWN || !('halt' in found)) return found;
    await end(ctx, setupDecision(found));
    return STOOD_DOWN;
}

/**
 * The post-helpers, then the publish, each fenced on a stand-down: a Stop, lost lease or Remove
 * that lands during either must not push to a tree another attempt owns or open a PR for a
 * deleted thread. Null when the attempt stood down (already settled), nothing left to report.
 */
async function runPostHelpersAndPublish(
    ctx: AttemptCtx,
    outcome: RunPhaseResult
): Promise<{
    helperFailure: HelperFailureReport | null;
    published: PublishResult | null;
    policyRefusal: string | null;
} | null> {
    const { rt, job, state } = ctx;
    const helperFailure = await endingPostHelpers(ctx, postHelperSkipWhy(outcome.outcome));
    if (helperFailure === STOOD_DOWN) return null;
    const ledger = ledgerOf({ ...outcome, helperFailure, published: null });
    let published: PublishResult | null = null;
    const policyRefusal: string | null = null;
    const mode = publishModeOf(job, ledger);
    if (mode !== null) {
        // The configured evidence is enforced HERE, whatever the agent chose to run: a refusal
        // pushes nothing, and an authorisation binds the push to the revision it assessed. A
        // refused draft is no refusal of its own: the services fault already fails the verdict.
        const decision = evidenceDecision(job.policy, gatesEvidenceOf(outcome.evidence), job.review);
        if (!decision.ok) return { helperFailure, published, policyRefusal: mode === 'draft' ? null : decision.reason };
        const githubToken = await askGithubToken(rt, job, 'the publish');
        // The fence sits BETWEEN the ask and the push: a Stop during the ask killed the runner,
        // and pushing now would outlive it. The push itself is never fenced — it cannot be
        // recalled (issue #472).
        if (await endIfDown(ctx, 'its publish')) return null;
        published = await publishBranch(rt, job, githubToken, publishOptionsOf(mode, decision.revision));
        // A lease lost while the push ran stands down here WITHOUT reporting what it pushed: the
        // next holder re-runs the publish (`publishBranch` is the one call that is not abortable).
        if (await endIfDown(ctx, 'its publish')) return null;
        // The agent already shipped its work as a draft: a clean tree leaves nothing to push, and
        // the verdict still carries the publication the agent made.
        if (published?.ok && !published.published && state.draftPublication) published = state.draftPublication;
    }
    return { helperFailure, published, policyRefusal };
}

/** Tells the board the id of a session this attempt starts; a failed report never blocks the run. */
async function reportNewSession(
    rt: LoopRuntime,
    job: BoardJob,
    session: ReturnType<typeof pickSession>
): Promise<void> {
    if (!session || session.resume) return;
    try {
        await rt.board.session(job, session.id);
    } catch (e) {
        rt.log(`job ${job.id}: could not report the session, continuing: ${(e as Error).message}`);
    }
}

/**
 * The task tree's fingerprint as the run left it, before the gates; compared with the startup
 * sync's to answer whether the tree moved. Null when unknown: no before-fingerprint, or a probe
 * that failed.
 */
async function probeTreeNow(ctx: AttemptCtx): Promise<string | null> {
    const { rt, job, treeBefore, state } = ctx;
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

/** The ad-hoc gate history one attempt's timeout note quotes, read before the session's teardown. */
function gateHistory(rt: LoopRuntime, gateSession: GateSession | null): readonly GateRunNote[] {
    if (gateSession === null) return [];
    return rt.gates?.server.lastRuns(gateSession.token) ?? [];
}

/**
 * A launch the board refused in the claim itself: the executor selection, then the selected
 * skills (issue #545), then the execution plan (a `.bellows.yaml` that does not resolve at the
 * claimed revision, or services that cannot share one pod). All `config`: the member fixes the
 * settings, the selection or the file and retries, and a batch asks a person instead of retrying
 * it as infrastructure. True when the task was failed here and nothing may launch — no sync, no
 * service, no gate environment, no agent.
 */
async function failOnClaimRefusal(rt: LoopRuntime, job: BoardJob): Promise<boolean> {
    const refusal = claimRefusalOf(rt, job);
    if (!refusal) return false;
    const [reason, failureKind, what] = refusal;
    logRefusal(rt.log, job, `job ${job.id}: ${what} is not runnable, failing`);
    await report(rt, job, { status: 'failed', exitCode: null, output: reason, failureKind }).catch((e: Error) =>
        rt.log(`job ${job.id}: could not report the ${what} failure: ${e.message}`)
    );
    return true;
}

/**
 * The first refusal the claim carries, in order: the executor selection, the selected skills, the
 * plan, then the master prompt. The board always renders a master prompt for every agent claim
 * (server/src/db/master-prompt.ts); a missing, oversized or malformed one is a contract violation,
 * never a reason to run the agent with no Factory execution context. Checked before any setup —
 * including a helper-only node's pre-helper, which might otherwise conclude the job without ever
 * spawning an agent. The plan and the prompt are only read when nothing before them refused.
 */
function claimRefusalOf(rt: LoopRuntime, job: BoardJob): readonly [string, 'config' | 'runner_error', string] | null {
    const executorRefusal =
        job.executorRefusal ||
        (job.executorType === null
            ? 'The selected executor no longer exists. Choose a configured executor and start a new task.'
            : null);
    if (executorRefusal) return [executorRefusal, 'config', 'executor selection'];
    if (job.skillRefusal) return [job.skillRefusal, 'config', 'selected skills'];
    const planRefusal = job.planRefusal ?? servicePlanRefusal(rt.config, job);
    if (planRefusal) return [planRefusal, 'config', 'execution plan'];
    const promptRefusal = masterPromptRefusalReason(job);
    return promptRefusal ? [promptRefusal, 'runner_error', 'master prompt'] : null;
}

/**
 * One attempt, end to end: the startup setup (the reclaim barrier, the checkout sync, the
 * plan check, the gate environment) and the run itself. The setup lives here rather than in
 * the claim loop so the attempt's state — heartbeat, abort signal, cleanup — covers all of it:
 * a Stop issued while the dashboard says "Waiting for the executor…" interrupts the setup
 * within one heartbeat poll and stands the attempt down before anything spawns (issue #126).
 */
export async function runJob(rt: LoopRuntime, job: BoardJob): Promise<void> {
    const { log } = rt;
    const executorType = job.executorType;
    if (await failOnClaimRefusal(rt, job)) return;

    const state = newJobState();
    state.trace = (t) => log(transitionLine(job, t));
    // In flight for a drain's handover (`loop.ts`) until it settles.
    const over = registerLive(rt, job, state);
    const beating = heartbeat(rt, job, state);
    // Armed before the run so the runner can hand over tails from its first chunk; the pump's
    // snapshot is the liveness read the timeout note is built from (issue #339).
    const outputPump = watchOutput(rt, job, state);
    const session = pickSession(job, executorType);

    /*
     * Lands a verdict the heartbeat observed before the runner spawned — a Stop, a lost lease
     * or a Remove that arrived while this attempt was still syncing its checkout or booting
     * its gate environment (issue #126). `standDown` (`loop-fence.ts`) reads it as a decision and
     * `end` (`loop-conclusion.ts`) is the only thing that acts on one — once per attempt, however
     * many exits ask (issue #820): it parks the attempt, then tears it down.
     */
    const quiesce = attemptQuiesce(rt, job, state, beating);
    const ctx: AttemptCtx = { rt, job, state, quiesce, fenced: false, treeBefore: null, session };
    try {
        log(`job ${job.id}: attempt ${job.attempts} ${sessionNote(session)}`);

        const gateSession = await runPhases(ctx);
        if (gateSession === STOOD_DOWN) return;
        state.gateToken = gateSession?.token ?? null;
        // A stand-down kills the runner, but not a gate its agent asked for: the token dies and
        // every ad-hoc run of it in flight is cancelled the moment the verdict lands.
        if (gateSession)
            state.signal.addEventListener('abort', () => rt.gates?.server.cancel(gateSession.token), {
                once: true,
            });

        const outcome = await runAttempt(ctx, { session: ctx.session, gateSession, executorType, pump: outputPump });
        if (outcome.done) return;
        const closing = await runPostHelpersAndPublish(ctx, outcome);
        if (closing === null) return;
        const { helperFailure, published, policyRefusal } = closing;
        // Staged, completed, then torn down (issue #821). The liveness read and the gate verdicts
        // are read BEFORE the teardown releases the gate session — unregistering clears the
        // recorded runs.
        await reportFinish(ctx, {
            job,
            outcome: outcome.outcome,
            failure: outcome.failure,
            deadServices: outcome.deadServices,
            recoveredServices: outcome.recoveredServices,
            helperFailure,
            published,
            endedAt: outcome.endedAt,
            deadlineExtensionMs: state.deadlineExtensionMs,
            activity: outputPump.snapshot(),
            gateRuns: gateHistory(rt, gateSession),
            gatesSkipped: outcome.gatesSkipped,
            treeChanged: outcome.treeChanged,
            evidence: outcome.evidence,
            policyRefusal,
        });
    } catch (e) {
        // The run threw — docker is missing, the daemon or apiserver refused, or this driver lost
        // its own credentials mid-run. Deliberately NOT reported as a failed job: that would blame
        // the command for the driver's problem. Nor handed back as an interruption (issue #822): a
        // runner may have survived — a force-deleted driver pod reads its own Job with a revoked
        // token — and a freed lease lets the reaper sweep what the next claim should adopt.
        // A killed run can reject (the runner's own Job vanished under it): the stand-down
        // that killed it owns the settlement, not the lease.
        stopIfDraining(state);
        if (await endIfDown(ctx, 'its run')) return;
        await end(ctx, thrownRunDecision(job, e));
    } finally {
        over();
    }
}
