import type { Board, BoardJob } from '../board/board.js';
import type { DriverConfig } from '../config.js';
import { composeRuntimeSample, onOwnGroup } from '../runner.js';
import {
    mergeOpencodeOutcome,
    opencodeReadFailed,
    parseClaudeCloseRead,
    mergeClaudeCloseRead,
    CLAUDE_READ_NONE,
    type ClaudeCloseRead,
    parseOpencodeRunOutcome,
    readOpencodeWithRetries,
} from '../close-read.js';
import type { RunOutcome, RunSession, Runner } from '../runner.js';
import { adoptFinishedRunner, supervisorServing } from './k8s-adopt.js';
import type { OpencodeRunOutcome } from '../close-read.js';
import { killedOutcome, ledgerOf, RunnerAbandoned, RunnerKilled, RunnerVanished, vanishedOutcome } from './k8s-kill.js';
import { jobPath, jobPodsPath } from './k8s-auxspec.js';
import { acquireClaim, releaseClaimAfterGroupEnd } from './k8s-fence.js';
import { removeTaskVolumes } from './k8s-task-volume.js';
import { CheckpointUnrestorable, restoreTaskTree, unrestorableResult } from '../task-restore.js';
import { ensureGroup, finishGroup, forgetGroup, groupsOf, runnerGroupOf, takeGroupDown } from './k8s-group.js';
import { claudeTurnsStep, opencodeReadoutStep, runnerName } from './k8s-podspec.js';
import { podsOf, pollRunnerJobUntilTerminal, readJobStatus, readRunnerVerdict, readTyped } from './k8s-poll.js';
import {
    deadServices,
    forgetServices,
    restartServiceFleet,
    sidecarStatuses,
    startServiceFleet,
} from './k8s-services.js';
import { groupServices } from '../services.js';
import { rebindGroup } from './k8s-binding.js';
import { resizeGateSidecar, resizeReviewerSidecar, runGateInGroup, runReviewInGroup } from './k8s-gate.js';
import {
    expectOk,
    HTTP_ERROR_STATUS,
    isRecord,
    livePodOfItems,
    MS_PER_SECOND,
    parsePodMetrics,
    boundedBy,
    POLL_MS,
    waitOf,
    withSignal,
} from './k8s-transport.js';
import { abortableSleep, pollFor, type Sleep, timeLeft } from '../poll.js';
import { nonEmpty, stringsOnly } from './k8s-shapes.js';
import type { K8sDeps, K8sRequest, K8sResponse } from './k8s-transport.js';
import { reviewRunOf } from '../review/review-step.js';
import { checkoutDir } from '../publish/publish.js';
import type { ReclaimResult, SyncResult } from '../publish/publish.js';
import type { StepSink, SupervisorEndpoint } from '../step-control.js';
import { type KillRecord, settleEnd } from '../termination.js';
import {
    controlTokenOf,
    detailOf,
    orderGo,
    READOUT_STEP_TIMEOUT_MS,
    releaseSteps,
    runReadoutStep,
    runSyncStep,
    stepHostOf,
    supervisedStepMembers,
} from '../supervised-steps.js';
import { CLAUDE_CODE, OPENCODE } from '../executors.js';
import { KILL_WINDDOWN_MS, type SupervisorReport } from '../supervisor-contract.js';
import { readViaReaderJob, type ReaderResult } from './k8s-reader.js';

/**
 * The kubernetes `Runner`: assembles the fence (`k8s-fence.ts`), the pollers (`k8s-poll.ts`) and
 * the service sidecars (`k8s-services.ts`) into the same `run`/`kill`/`syncCheckout`/`publishGit`/
 * `reclaimWorktree` surface the docker runner exposes. See docs/kubernetes.md for the protocol
 * each method implements; every function here is a thin composition over the sibling files, kept
 * here because it is the runner's own close-time bookkeeping (the opencode/claude-turns scrapes,
 * the publish steps) rather than a reusable poll/fence primitive.
 */

/**
 * Whether a step answer lost its head to the supervisor's output cap: every line the readout prints
 * is a JSON object, so a first line that is not one was cut mid-line. A cut that fell on a line
 * boundary is undetectable here.
 */
function headCut(stdout: string): boolean {
    const first = stdout.split('\n', 1)[0]!.trim();
    if (!first) return false;
    try {
        JSON.parse(first);
        return false;
    } catch {
        return true;
    }
}

/**
 * How a close-time readout runs: a supervised step of the live group, or — for an adopted group that
 * has ended and has no supervisor to answer — a reader Job over the task volume (`k8s-reader.ts`).
 */
type Readout = (
    deps: K8sDeps,
    job: BoardJob,
    readout: { name: string; argv: string[]; env: Record<string, string>; timeoutMs?: number }
) => Promise<ReaderResult>;

const supervisedReadout: Readout = (deps, job, readout) => runReadoutStep(stepHostOf(deps), job, readout);

const readerJobReadout: Readout = (deps, job, readout) =>
    readViaReaderJob(deps, job, { ...readout, timeoutMs: readout.timeoutMs ?? READOUT_STEP_TIMEOUT_MS });

/**
 * The close-time readouts of one run, over the way they execute (`Readout`): the live group's, or an
 * adopted ended group's. NEVER throw — a failed read is "unmeasured", not a failed run.
 */
function closeReadsOver(readout: Readout) {
    /**
     * The close-time opencode session scrape, as a supervised step of the task group: the same read the
     * docker runner performs with a throwaway container after the run's close, against the database
     * the run persisted on the task volume. NEVER throws — the scrape is the run's follow-up-ability,
     * finish reason and context vitals, and a failed read is not a failed run.
     */
    async function scrapeOpencodeSession(
        deps: K8sDeps,
        job: BoardJob,
        startedAt: string,
        deadline: number
    ): Promise<OpencodeRunOutcome> {
        try {
            const answered = await readout(deps, job, {
                name: 'opencode-readout',
                ...opencodeReadoutStep(job, startedAt),
                timeoutMs: Math.min(READOUT_STEP_TIMEOUT_MS, timeLeft(deadline)),
            });
            if (answered.timedOut) return opencodeReadFailed('the session readout exceeded its deadline');
            if (answered.exitCode !== 0) {
                return opencodeReadFailed(
                    `the session readout step failed: ${detailOf(answered, READOUT_STEP_TIMEOUT_MS)}`
                );
            }
            return parseOpencodeRunOutcome(answered.stdout, answered.truncated === true || headCut(answered.stdout));
        } catch (e) {
            return opencodeReadFailed((e as Error).message);
        }
    }

    /**
     * The close-time claude-code read: one supervised step, its one answer parsed to the turn count and
     * the run's last words, or nulls. Every failure on the way answers nulls: unmeasured, never zero,
     * exactly the contract the docker twin's failed exec keeps.
     */
    async function scrapeClaudeCloseRead(
        deps: K8sDeps,
        job: BoardJob,
        sessionId: string,
        startedAt: string
    ): Promise<ClaudeCloseRead> {
        try {
            const answered = await readout(deps, job, {
                name: 'claude-turns',
                ...claudeTurnsStep(job, sessionId, startedAt),
            });
            return answered.exitCode === 0 && !answered.timedOut
                ? parseClaudeCloseRead(answered.stdout)
                : CLAUDE_READ_NONE;
        } catch {
            return CLAUDE_READ_NONE;
        }
    }

    async function attachOpencodeOutcome(
        deps: K8sDeps,
        job: BoardJob,
        startedAt: string,
        outcome: RunOutcome
    ): Promise<void> {
        const live = withSignal(deps, ledgerOf(deps).signal(job));
        const { scraped, reason } = await readOpencodeWithRetries(
            (deadline) => scrapeOpencodeSession(live, job, startedAt, deadline),
            deps.sleep,
            live.signal
        );
        mergeOpencodeOutcome(outcome, scraped, reason);
    }
    return { scrapeClaudeCloseRead, attachOpencodeOutcome };
}

const { scrapeClaudeCloseRead, attachOpencodeOutcome } = closeReadsOver(supervisedReadout);

/** An adoption's close-time readouts: its group has ended, so each runs as a reader Job, never a step. */
const adoptionReads = closeReadsOver(readerJobReadout);

// The docker runner samples `docker stats`; the twin here is the metrics API, read from the
// runner's own pod. Every failure (no pod yet, no metrics-server, a blink) answers null for the
// NUMBERS: "no fresh sample", never an error. The services are the pod's own sidecars (issue #773),
// read off its status before and independently of the metrics API, so a cluster with no
// metrics-server still reports them.
async function sampleRuntime(deps: K8sDeps, job: BoardJob) {
    const specs = groupServices(deps.config, job);
    let pods: K8sResponse;
    try {
        pods = await deps.request('GET', jobPodsPath(deps.config.k8sNamespace, runnerName(job)));
    } catch {
        return null;
    }
    const read = podsOf(pods, 'listing the runner pods');
    const live = read.kind === 'value' ? livePodOfItems(read.value) : undefined;
    const services =
        specs.length > 0 && live
            ? sidecarStatuses(live, specs).map(({ name, image, state }) => ({ name, image, state }))
            : undefined;
    const runnerPod = live?.metadata?.name;
    if (!runnerPod) return composeRuntimeSample(null, services);
    let metrics: K8sResponse;
    try {
        metrics = await deps.request(
            'GET',
            `/apis/metrics.k8s.io/v1beta1/namespaces/${deps.config.k8sNamespace}/pods/${runnerPod}`
        );
    } catch {
        return composeRuntimeSample(null, services);
    }
    if (metrics.status >= HTTP_ERROR_STATUS) return composeRuntimeSample(null, services);
    return composeRuntimeSample(parsePodMetrics(metrics.body), services);
}

// The same contract as `docker kill ... .catch(() => undefined)`: a kill that finds nothing is the
// ordinary end of a finished run. The group is ended the acknowledged way (issue #821) — its
// Secrets, then its Job, confirmed gone — and the checkout claim goes back only on that
// confirmation; a kill whose end cannot be confirmed leaves the Job suspended and keeps the claim.
async function killRunner(deps: K8sDeps, job: BoardJob): Promise<void> {
    ledgerOf(deps).note(job, 'hard');
    // The group is gone with its pod: a step still running in its supervisor (a pre-helper writing
    // to GitHub, a publish) dies with it, and its waiters see the channel close. Its end is pending
    // from here, before anything is awaited.
    const known = forgetGroup(deps, job);
    releaseSteps(stepHostOf(deps), job);
    forgetServices(deps, job);
    await releaseClaimAfterGroupEnd(deps, job, { groups: [runnerGroupOf(job, known?.uids)] });
}

/**
 * Ends the agent under its supervisor. The loop has already raised the kill order on the control
 * channel (`killAgent`), so the supervisor ends the agent, has the exporter drain what the agent
 * wrote and finalizes — the pod then ends by itself and `run` reads its real outcome. This only
 * waits, bounded, for that, and past the bound falls back to the hard kill every other path uses:
 * the backstop for a supervisor that is gone. Never throws, like `kill`.
 */
export async function stopAgent(deps: K8sDeps, job: BoardJob): Promise<void> {
    const ended = await pollFor<'ended' | 'unread'>(
        { ...waitOf(deps, KILL_WINDDOWN_MS), everyMs: POLL_MS },
        async (deadline) => {
            const read = await readJobStatus(
                boundedBy(deps, deadline),
                runnerName(job),
                'reading the runner job'
            ).catch(() => null);
            if (!read || read.kind === 'error') return 'unread';
            if (read.kind === 'notFound' || read.kind === 'terminal') return 'ended';
        }
    );
    if (ended === 'ended') {
        // The supervisor ended the group, its service sidecars with it: nobody is left to answer its steps.
        releaseSteps(stepHostOf(deps), job);
        forgetServices(deps, job);
        return;
    }
    await killRunner(deps, job);
}

/** Persist the paused budget on the Job so waiting has no kubelet deadline. */
const PAUSED_DEADLINE = 'bellows.ai/paused-deadline';
const deadlineChains = new Map<string, Promise<void>>();

/** Serialize deadline patches so overlapping question and Stop updates cannot lose a budget. */
function pauseRunnerDeadline(deps: K8sDeps, job: BoardJob, paused: boolean): Promise<void> {
    const name = runnerName(job);
    const next = (deadlineChains.get(name) ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => patchRunnerDeadline(deps, job, paused));
    deadlineChains.set(name, next);
    void next
        .catch(() => undefined)
        .then(() => {
            if (deadlineChains.get(name) === next) deadlineChains.delete(name);
        });
    return next;
}

interface DeadlineJob {
    spec?: { activeDeadlineSeconds?: number };
    metadata?: { uid?: string; annotations?: Record<string, string> };
}

/** A Job the deadline patch may write to: it names its incarnation (a uid) and every field consumed is well-typed. */
const asDeadlineJob = (value: unknown): DeadlineJob | null => {
    if (!isRecord(value) || !isRecord(value.metadata) || !nonEmpty(value.metadata.uid)) return null;
    const { spec } = value;
    if (
        spec !== undefined &&
        !(isRecord(spec) && (spec.activeDeadlineSeconds === undefined || Number.isFinite(spec.activeDeadlineSeconds)))
    ) {
        return null;
    }
    const { annotations } = value.metadata;
    return annotations === undefined || stringsOnly(annotations) ? (value as DeadlineJob) : null;
};

/** The saved `{deadline, at}` annotation, or null unless both are finite numbers. */
function asSavedDeadline(saved: string): { deadline: number; at: number } | null {
    try {
        const value: unknown = JSON.parse(saved);
        return isRecord(value) && Number.isFinite(value.deadline) && Number.isFinite(value.at)
            ? (value as { deadline: number; at: number })
            : null;
    } catch {
        return null;
    }
}

/** Save and remove a paused deadline, or restore its budget including the elapsed wait. */
async function patchRunnerDeadline(deps: K8sDeps, job: BoardJob, paused: boolean): Promise<void> {
    const path = jobPath(deps.config.k8sNamespace, runnerName(job));
    const read = await readTyped(deps, path, 'reading the runner job for its deadline', {
        shape: asDeadlineJob,
        once: true,
    });
    if (read.kind === 'absent') return;
    if (read.kind === 'inconclusive') throw new Error(read.reason);
    const current = read.value;
    const saved = current.metadata?.annotations?.[PAUSED_DEADLINE];
    if (paused && saved) return;
    if (!paused && !saved) return;
    const deadline = current.spec?.activeDeadlineSeconds;
    if (paused && typeof deadline !== 'number') return;
    const prior = saved ? asSavedDeadline(saved) : null;
    if (saved && !prior) throw new Error(`the runner job's saved deadline is not a deadline and a time: ${saved}`);
    const patched = await deps.request('PATCH', path, {
        metadata: {
            // The incarnation just read, by uid: never one created under the name since.
            uid: current.metadata?.uid,
            annotations: {
                [PAUSED_DEADLINE]: paused ? JSON.stringify({ deadline, at: Date.now() }) : null,
            },
        },
        spec: {
            activeDeadlineSeconds: prior ? prior.deadline + Math.ceil((Date.now() - prior.at) / MS_PER_SECOND) : null,
        },
    });
    expectOk(patched, 'pausing or resuming the runner job deadline');
}

/** The per-run inputs `run0` needs beyond the job itself — bundled to stay under the 4-param cap. */
interface RunRequest {
    session: RunSession | null;
    onOutput: ((tail: string) => void) | undefined;
}

/** Whether the supervisor has reported this attempt's agent over: set by the report wait `run0` starts. */
interface ReportWatch {
    report: SupervisorReport | null;
}

// The body of run() below, split out only so its cleanup can wrap the throw paths too.
async function run0(deps: K8sDeps, job: BoardJob, req: RunRequest): Promise<RunOutcome> {
    const { session, onOutput } = req;
    // A null session is an opencode job under this executor; under claude-code every job is a
    // session, and one arriving without is refused here, BEFORE the fence takes the checkout.
    if (!session && job.executorType !== OPENCODE) {
        throw new Error(`refusing to run job ${job.id}: the kubernetes runner runs every job as a session`);
    }
    // One Job, one pod: the agent, the task supervisor that owns its lifecycle and — for a run that
    // exports its transcript — the exporter, created together by the attempt's first step (the
    // sync) or, for an attempt that never synced, here. A pod the cluster refuses is infrastructure,
    // thrown like any refused runner Job, never a run that silently loses its record. The declared
    // services are the pod's own sidecars (issue #773), waited ready by the loop's setup
    // (`startServices`) before its gate environment, and reached on the pod's loopback by name.
    const { startedAt, resumed } = await ensureGroup(deps, job, session);

    // The agent waits on the supervisor's release; the order hands the supervisor what is left of
    // the run budget. The agent's end does not end the pod: the supervisor has the exporter drain,
    // reports, and serves the attempt's steps until the loop finishes the group — which is what
    // lets a kill of the agent still leave its transcript whole, and the publish run beside it.
    const watch: ReportWatch = { report: null };
    const host = stepHostOf(deps);
    void host.sink.awaitReport(controlTokenOf(job)).then(
        (report) => {
            watch.report = report;
        },
        () => undefined
    );
    // A group taken over from a lost driver (#829) was released by it: the agent already runs, in the
    // sizing and under the order its first driver gave, and nothing here creates or releases it.
    // The agent's run is the gate sidecar's idle phase: its requests come down until the verify.
    if (!resumed) await resizeGateSidecar(deps, job, 'idle').then(() => orderGo(host, job));

    let polled: { timedOut: boolean; jobSucceeded: boolean };
    try {
        polled = await pollRunnerJobUntilTerminal(deps, job, {
            onOutput,
            over: () => watch.report !== null,
            agentEnded: () => host.sink.agentEnded(controlTokenOf(job)),
        });
    } catch (e) {
        // A Stop deleted the Job: the loop parks a resolved outcome (docker's killed container
        // resolves exit 137), where a rejection would be left to the lease.
        // An abandoned attempt's outcome is ignored (`abandonOnHandover`): its Job is the next holder's.
        if (e instanceof RunnerKilled || e instanceof RunnerAbandoned) return killedOutcome();
        // The run cannot be read to its end — the Job vanished, or the cluster refused: nothing
        // more is asked of the group but `finish`, and nothing left may make it wait.
        releaseSteps(host, job);
        // Deleted under the run by anything else: the platform took the runner away, as docker's
        // removed container — an interruption for the next claim, never a run the lease redoes —
        // unless the budget had already ended the agent, as the supervisor's report says.
        if (e instanceof RunnerVanished) return vanishedOutcome(e, watch.report);
        throw e;
    }
    // The Job ended with no report taken — its supervisor finalized unheard, or was lost: nobody is
    // left to answer the probe, the publish or the `finish` the loop still sends.
    if (watch.report === null) releaseSteps(host, job);
    const { jobSucceeded } = polled;
    // The reads after the Job ended stand on the attempt's kill too.
    const live = withSignal(deps, ledgerOf(deps).signal(job));
    const { exitCode, output, fullLog, logTruncated, vanished, unfinalized, supervisorDeadline } =
        await readRunnerVerdict(live, job, jobSucceeded, { report: watch.report });
    // The run budget ends the agent through the supervisor (its report, then its exit 124), the
    // kubelet's deadline only a supervisor that stopped doing so: either is the timeout's verdict.
    // A deadline kill deletes the pod too: that is the timeout's verdict, never a loss.
    const timedOut = polled.timedOut || supervisorDeadline;
    const { infraLoss } = settleEnd({
        kills: [],
        driverKilledHard: ledgerOf(deps).was(job).hard,
        report: watch.report,
        budgetEnded: timedOut,
        vanished,
        unfinalized,
    });
    if (infraLoss) return { exitCode, output, timedOut, started: true, infraLoss };

    const outcome: RunOutcome = { exitCode, output, timedOut, started: true, fullLog, logTruncated };

    if (job.executorType === OPENCODE) {
        // The session export rides the same readout, one consistent snapshot with its figures.
        await attachOpencodeOutcome(live, job, startedAt, outcome);
    }

    if (job.executorType === CLAUDE_CODE && session) {
        const read = await scrapeClaudeCloseRead(live, job, session.id, startedAt);
        mergeClaudeCloseRead(outcome, read);
    }
    return outcome;
}

// The checkout claim outlives run(): the group does — the gates, the publish and the helpers are its
// steps — and the group's end (`finish`, a kill) is what hands the claim back, once confirmed (issue
// #821). A run that threw before its group existed has no end to wait for: a launch that got as far
// as its Job ended it at its stand-down, and the claim goes back unless that end is unconfirmed. The
// service sidecars live as long as the group: the declared gates run after run() against them.
async function run(
    deps: K8sDeps,
    job: BoardJob,
    session: RunSession | null,
    onOutput?: (tail: string) => void
): Promise<RunOutcome> {
    try {
        return await run0(deps, job, { session, onOutput });
    } catch (e) {
        if (!groupsOf(deps).has(job.leaseToken)) await releaseClaimAfterGroupEnd(deps, job);
        throw e;
    }
}

/**
 * The startup sync: the loop calls it on every claim, the task worktree does not exist until
 * something creates it, and a refusal would fail every claimed job. It is the attempt's first
 * step, so it is what creates the attempt's group — the supervisor runs it, then runs the agent
 * the loop releases next. The fence comes BEFORE the group: the sync is the first writer on the
 * task worktree, so the checkout claim is taken here, and the group's own `prepare` recognizes its
 * holder and proceeds.
 */
async function syncCheckout(
    deps: K8sDeps,
    job: BoardJob,
    session: RunSession | null = null,
    { githubToken, signal }: { githubToken?: string | undefined; signal?: AbortSignal | undefined } = {}
): Promise<SyncResult> {
    if (!checkoutDir(job)) return { ok: true, reason: null }; // nothing synced, nothing to fail either

    await acquireClaim(deps, job);
    // A group that could not come up is thrown, typed when the pod's words prove why (`StartupRefused`,
    // the loop's one startup decision, #824 D11) and plain for the lease otherwise. The claim goes
    // back only once nothing of this group can still write the worktree (`takeGroupDown`).
    const failed = (): Promise<void> => takeGroupDown(deps, job);
    try {
        await ensureGroup(deps, job, session, signal);
    } catch (e) {
        await failed();
        // A thread that cannot be rebuilt is a verdict, not a fault of the cluster: the loop fails the task with it.
        if (e instanceof CheckpointUnrestorable) return unrestorableResult(e);
        throw e;
    }
    try {
        const host = stepHostOf(deps);
        // A volume made by a restore is filled before the sync looks at it; the generation it replaces goes after.
        const restored = await restoreTaskTree(host, job, {
            githubToken,
            removeOlder: (generations) => removeTaskVolumes(signal ? withSignal(deps, signal) : deps, job, generations),
        });
        const result = restored && !restored.ok ? restored : await runSyncStep(host, job, githubToken);
        // A failed sync means no runner follows — nobody else would give the checkout back.
        if (!result.ok) await failed();
        return result;
    } catch (e) {
        // A thrown sync — the channel closed under it, the answer never came — releases the claim
        // the same way: holding it would only leave the next claimant to take it over.
        await failed();
        throw e;
    }
}

/**
 * The terminal reclaim is an acknowledged no-op (issue #775): the thread's tree lives on its own task
 * volume, which only the reaper may delete, so there is no linked worktree to remove.
 */
async function reclaimWorktree(): Promise<ReclaimResult> {
    return { ok: true, removed: false, reason: null };
}

/**
 * The kubernetes Runner. `request` is injected — the `createBoard(computeFetch)` pattern — and so
 * is `sleep`, which is what lets the poll loop be tested without two seconds per poll. `leases` is
 * the board's lease lookup the checkout-claim fence asks about a claim it cannot order.
 */
export function createKubernetesRunner(
    config: DriverConfig,
    request: K8sRequest,
    sleep: Sleep = abortableSleep,
    wiring: {
        leases?: Board['leases'];
        checkpoints?: Pick<Board, 'checkpoint'>;
        steps?: StepSink;
        endpoint?: SupervisorEndpoint;
    } = {}
): Runner {
    const { leases, checkpoints, steps, endpoint } = wiring;
    const deps: K8sDeps = {
        config,
        request,
        sleep,
        ...(leases ? { leases } : {}),
        ...(checkpoints ? { checkpoints } : {}),
        ...(steps ? { steps } : {}),
        ...(endpoint ? { endpoint } : {}),
    };
    return onOwnGroup({
        sampleRuntime: (job: BoardJob) => sampleRuntime(deps, job),
        kill: (job: BoardJob) => killRunner(deps, job),
        stopAgent: (job: BoardJob) => stopAgent(deps, job),
        recordKill: (job: BoardJob, kill: KillRecord) => ledgerOf(deps).record(job, kill),
        pauseDeadline: (job: BoardJob, paused: boolean) => pauseRunnerDeadline(deps, job, paused),
        // The sidecars end with the group; what is released is the driver's memory of them.
        releaseServices: async (job: BoardJob) => forgetServices(deps, job),
        deadServices: (job: BoardJob) => deadServices(deps, job),
        restartServices: (job: BoardJob, signal: AbortSignal) => restartServiceFleet(deps, job, signal),
        startServices: (job: BoardJob, signal?: AbortSignal) => startServiceFleet(deps, job, signal),
        run: (job: BoardJob, session: RunSession | null, onOutput?: (tail: string) => void) =>
            run(deps, job, session, onOutput),
        adopt: (job: BoardJob, signal?: AbortSignal) => adoptFinishedRunner(deps, job, adoptionReads, signal),
        ...supervisedStepMembers({
            host: stepHostOf(deps),
            hasGroup: (job) => groupsOf(deps).has(job.leaseToken),
            // The claim the group took is the group's end's to give back (`finishGroup`), never this call's.
            createGroup: (job) => ensureGroup(deps, job, null),
            errorDetail: (e) => (e as Error).message,
        }),
        runGate: (job, gate, signal) => runGateInGroup(deps, job, gate, signal),
        resizeGate: (job, phase) => resizeGateSidecar(deps, job, phase),
        resizeReviewer: (job, phase) => resizeReviewerSidecar(deps, job, phase),
        runReview: (caller, review, session, control) =>
            runReviewInGroup(deps, reviewRunOf(caller, review, session, control), control?.signal),
        rebind: (group, binding, signal) => rebindGroup(deps, group, binding, signal),
        supervisorServing: (group, bound) => supervisorServing(deps, group, bound),
        abandon: (job) => ledgerOf(deps).abandon(job),
        syncCheckout: (job: BoardJob, signal?: AbortSignal, session?: RunSession | null, githubToken?: string) =>
            syncCheckout(deps, job, session ?? null, { githubToken, signal }),
        finish: (job: BoardJob) => finishGroup(deps, job),
        reclaimWorktree,
        // The loop's hand-back of the checkout claim (`loop-fence.ts`) for an attempt that ends
        // without a group's end to give it back: a group still live keeps it for its `finish`
        // (issue #821), one whose end is unconfirmed keeps it for good.
        releaseFence: async (job: BoardJob) => {
            await releaseClaimAfterGroupEnd(deps, job);
        },
    });
}
