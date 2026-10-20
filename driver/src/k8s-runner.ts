import type { Board, BoardJob } from './board.js';
import type { DriverConfig } from './config.js';
import { composeRuntimeSample } from './runner.js';
import {
    mergeOpencodeOutcome,
    opencodeReadFailed,
    parseClaudeCloseRead,
    mergeClaudeCloseRead,
    CLAUDE_READ_NONE,
    type ClaudeCloseRead,
    parseOpencodeRunOutcome,
    readOpencodeWithRetries,
} from './close-read.js';
import type { RunOutcome, RunSession, Runner } from './runner.js';
import { adoptFinishedRunner } from './k8s-adopt.js';
import type { OpencodeRunOutcome } from './close-read.js';
import { killedOutcome, ledgerOf, RunnerAbandoned, RunnerKilled, RunnerVanished, vanishedOutcome } from './k8s-kill.js';
import { claimName, deleteJob, jobPath, jobPodsPath, podLogPath } from './k8s-auxspec.js';
import {
    acquireClaim,
    type ObservedClaim,
    readClaim,
    readClaimObject,
    releaseClaimAfterGroupEnd,
    revokeClaim,
} from './k8s-fence.js';
import {
    ensureGroup,
    finishGroup,
    forgetGroup,
    groupsOf,
    holderGroupsOf,
    reclaimInGroup,
    runnerGroupOf,
    takeGroupDown,
} from './k8s-group.js';
import { claudeTurnsJobSpec, jobsPath, opencodeReadoutJobSpec, runnerName } from './k8s-podspec.js';
import {
    auxVerdict,
    pollJobToTerminal,
    podsOf,
    pollRunnerJobUntilTerminal,
    readJobStatus,
    readRunnerVerdict,
    readTyped,
    readLogVerdict,
    readVerdict,
} from './k8s-poll.js';
import {
    deadServices,
    forgetServices,
    restartServiceFleet,
    sidecarStatuses,
    startServiceFleet,
} from './k8s-services.js';
import { groupServices } from './services.js';
import { rebindGroup } from './k8s-binding.js';
import { resizeGateSidecar, resizeReviewerSidecar, runGateInGroup, runReviewInGroup } from './k8s-gate.js';
import {
    answerPreview,
    expectOk,
    HTTP_ERROR_STATUS,
    isRecord,
    livePodOfItems,
    MS_PER_SECOND,
    parsePodMetrics,
    boundedBy,
    POLL_MS,
    refusal,
    waitOf,
    withSignal,
} from './k8s-transport.js';
import { abortableSleep, pollFor, type Sleep } from './poll.js';
import { nonEmpty, stringsOnly } from './k8s-shapes.js';
import type { K8sDeps, K8sRequest, K8sResponse } from './k8s-transport.js';
import { reviewRunOf } from './review-step.js';
import { repoPath, worktreeDir } from './publish.js';
import type { ReclaimResult, SyncResult } from './publish.js';
import type { StepSink, SupervisorEndpoint } from './step-control.js';
import { type KillRecord, settleEnd } from './termination.js';
import {
    controlTokenOf,
    orderGo,
    releaseSteps,
    runSyncStep,
    stepHostOf,
    supervisedStepMembers,
} from './supervised-steps.js';
import { CLAUDE_CODE, OPENCODE } from './executors.js';
import { KILL_WINDDOWN_MS, type SupervisorReport } from './supervisor-contract.js';
import { parseRfc3339 } from './timestamps.js';

/**
 * The kubernetes `Runner`: assembles the fence (`k8s-fence.ts`), the pollers (`k8s-poll.ts`) and
 * the service sidecars (`k8s-services.ts`) into the same `run`/`kill`/`syncCheckout`/`publishGit`/
 * `reclaimWorktree` surface the docker runner exposes. See docs/kubernetes.md for the protocol
 * each method implements; every function here is a thin composition over the sibling files, kept
 * here because it is the runner's own close-time bookkeeping (the opencode/claude-turns scrapes,
 * the publish steps) rather than a reusable poll/fence primitive.
 */

/**
 * The close-time opencode session scrape, as a Job: the same read the docker runner performs with
 * a throwaway container after the run's close, against the database the run persisted on the
 * PVC. NEVER throws — the scrape is the run's follow-up-ability, finish reason and context vitals,
 * and a failed read is not a failed run.
 */
async function scrapeOpencodeSession(
    deps: K8sDeps,
    job: BoardJob,
    startedAt: string,
    deadline: number
): Promise<OpencodeRunOutcome> {
    const bounded = boundedBy(deps, deadline);
    const fail = opencodeReadFailed;
    let spec: ReturnType<typeof opencodeReadoutJobSpec>;
    try {
        spec = opencodeReadoutJobSpec(deps.config, job, startedAt);
    } catch (e) {
        return fail((e as Error).message);
    }
    const jobName = spec.metadata.name;
    try {
        const created = await bounded.request('POST', jobsPath(deps.config.k8sNamespace), spec);
        const refused = refusal(created, 'creating the session readout');
        if (refused) return fail(refused);
        // pollJobToTerminal re-throws a read whose patience ran out (issue #308) — infrastructure,
        // never the run's verdict. EVERY failure this block can raise — a transport rejection on
        // the Job POST included — lands in the catch below: the scrape is the run's
        // follow-up-ability, and a completed run's verdict must never burn over its close-time
        // read.
        const pollFailure = await pollJobToTerminal(bounded, jobName, {
            what: 'the session readout',
            notFound: (n) => `the session readout ${n} no longer exists`,
            errorStatus: (s, b) => `reading the session readout ${answerPreview(s, b)}`,
            failed: 'the session readout job failed — its own deadline is its bound',
        });
        if (pollFailure !== null) return fail(pollFailure);
        const pods = await readVerdict(
            bounded,
            jobPodsPath(deps.config.k8sNamespace, jobName),
            'listing the session readout pods'
        );
        if (pods.status >= HTTP_ERROR_STATUS)
            return fail(`listing the session readout pods ${answerPreview(pods.status, pods.body)}`);
        const read = podsOf(pods, 'listing the session readout pods');
        const pod = read.kind === 'value' ? livePodOfItems(read.value) : undefined;
        if (!pod?.metadata?.name) return fail('the session readout left no pod to read its output from');
        const log = await readLogVerdict(
            bounded,
            podLogPath(deps.config.k8sNamespace, pod.metadata.name, null),
            'reading the session readout log'
        );
        if (log.status >= HTTP_ERROR_STATUS)
            return fail(`reading the session readout's log ${answerPreview(log.status, log.body)}`);
        return parseOpencodeRunOutcome(log.body, log.truncated === true);
    } catch (e) {
        return fail((e as Error).message);
    } finally {
        void deleteJob(deps, jobName);
    }
}

/**
 * The close-time claude-code read: one aux Job over the PVC, its one answer parsed to the turn
 * count and the run's last words, or nulls. Every failure on the way answers nulls: unmeasured,
 * never zero, exactly the contract the docker twin's failed exec keeps.
 */
async function scrapeClaudeCloseRead(
    deps: K8sDeps,
    job: BoardJob,
    sessionId: string,
    startedAt: string
): Promise<ClaudeCloseRead> {
    let spec: ReturnType<typeof claudeTurnsJobSpec>;
    try {
        spec = claudeTurnsJobSpec(deps.config, job, sessionId, startedAt);
    } catch {
        return CLAUDE_READ_NONE;
    }
    const jobName = spec.metadata.name;
    try {
        const created = await deps.request('POST', jobsPath(deps.config.k8sNamespace), spec);
        if (created.status >= HTTP_ERROR_STATUS) return CLAUDE_READ_NONE;
        const verdict = await auxVerdict(deps, jobName);
        return parseClaudeCloseRead(verdict.output);
    } catch {
        return CLAUDE_READ_NONE;
    } finally {
        void deleteJob(deps, jobName);
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
    const { startedAt } = await ensureGroup(deps, job, session);

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
    // The agent's run is the gate sidecar's idle phase: its requests come down until the verify.
    await resizeGateSidecar(deps, job, 'idle');
    await orderGo(host, job);

    let polled: { timedOut: boolean; jobSucceeded: boolean };
    try {
        polled = await pollRunnerJobUntilTerminal(deps, job, { onOutput, over: () => watch.report !== null });
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
    githubToken?: string
): Promise<SyncResult> {
    const clone = repoPath(deps.config, job);
    const worktree = worktreeDir(deps.config, job);
    if (!clone || !worktree) return { ok: true, reason: null }; // nothing synced, nothing to fail either

    await acquireClaim(deps, job);
    // A group that could not come up is thrown, typed when the pod's words prove why (`StartupRefused`,
    // the loop's one startup decision, #824 D11) and plain for the lease otherwise. The claim goes
    // back only once nothing of this group can still write the worktree (`takeGroupDown`).
    const failed = (): Promise<void> => takeGroupDown(deps, job);
    try {
        await ensureGroup(deps, job, session);
    } catch (e) {
        await failed();
        throw e;
    }
    try {
        const result = await runSyncStep(stepHostOf(deps), job, githubToken);
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
 * The checkout claim that held an acquire off, read for the refusal's report (issue #344): its
 * name, the holder attempt the claim carries, and the apiserver's creation stamp. The loop logs
 * these and — once the board proves the holder job gone — decides the reap. Undefined when the
 * claim cannot be read (gone in between, refused, a transport blink): the refusal message the
 * acquire threw already names what it knows, and this read only adds to it.
 */
async function heldClaim(deps: K8sDeps, job: BoardJob): Promise<ReclaimResult['heldClaim']> {
    const read = await readClaimObject(deps, job, true);
    if (read.kind !== 'value') return undefined;
    const claim = read.value;
    const uid = claim.metadata?.uid;
    const holder = claim.data?.holder;
    // A claim that cannot name its incarnation and holder is nothing a recovery may act on.
    if (!uid || !holder) return undefined;
    const createdAt = claim.metadata?.creationTimestamp;
    return {
        name: claimName(job),
        claimSeq: claim.data?.claimSeq ?? null,
        createdMs: createdAt === undefined ? null : parseRfc3339(createdAt),
        uid,
        holder,
    };
}

/**
 * Deletes an orphaned checkout claim (issue #344): a claim whose holder job the board no longer
 * knows as live, left behind by a driver that died holding it — the one leak the fence's
 * release-by-next-claimant cannot heal, because no later claimant of that job ever comes. The
 * claim is the incarnation the refused reclaim observed (issue #821): one replaced since — a
 * reopen's live claimant — is rejected before anything is ended. The claim is revoked first
 * (`revokeClaim`, under the reaping acquisition's token): a reclaim of the holder whose group was
 * not yet created when the groups are listed below then refuses to start it. Both groups its
 * holder can have left (its attempt's and its reclaim's, derived from the claim alone) are ended
 * the acknowledged way, and the uid-preconditioned delete runs only once both are confirmed ended.
 * Answers false otherwise — a refused revoke included: the caller retries on a later offer, and a
 * false negative costs one more throttled log.
 */
async function reapOrphanedClaim(deps: K8sDeps, job: BoardJob, observed: ObservedClaim): Promise<boolean> {
    if (!(await revokeClaim(deps, job, observed))) return false;
    const groups = await holderGroupsOf(deps, job, observed.holder);
    if (groups === null) return false;
    return releaseClaimAfterGroupEnd(deps, job, { groups, observed });
}

/**
 * The terminal reclaim (issue #47), the kubernetes shape: the remove script as a supervised step
 * (in a supervisor-only group — the thread has no attempt to ask), UNDER the checkout claim — the
 * same `acquireClaim` protocol the sync and the runner use.
 * An acquire that answers 409 means a LIVE attempt holds the checkout, and the reclaim SKIPS:
 * costing the reclaim is fine by contract, costing a live run is not. The refusal carries the
 * claim's identity (`heldClaim`) so the loop can name it, and reap it when the board proves the
 * holder gone (issue #344).
 */
async function reclaimWorktree(deps: K8sDeps, job: BoardJob): Promise<ReclaimResult> {
    const clone = repoPath(deps.config, job);
    const worktree = worktreeDir(deps.config, job);
    if (!clone || !worktree) return { ok: true, removed: false, reason: null };
    try {
        await acquireClaim(deps, job);
    } catch (e) {
        // A 409 the acquire could not resolve by takeover is a live attempt on the checkout
        // (acquireClaim says which and why in its message).
        const refused: ReclaimResult = {
            ok: false,
            removed: false,
            reason: `the checkout is held (${worktree}): ${(e as Error).message}`,
        };
        const claim = await heldClaim(deps, job);
        if (claim) refused.heldClaim = claim;
        return refused;
    }
    // The incarnation this reclaim took: its holder token is this acquisition's own (issue #821),
    // and the uid tells it apart from one an earlier invocation under the same token took.
    const acquired = await readClaim(deps, job);
    if (acquired?.holder !== job.leaseToken) {
        return { ok: false, removed: false, reason: 'the checkout claim this reclaim took could not be read back' };
    }
    try {
        // The group is ended inside, acknowledged — THEN the claim goes, unless that end is
        // unconfirmed, and only the incarnation this invocation took.
        return await reclaimInGroup(deps, job, acquired);
    } finally {
        await releaseClaimAfterGroupEnd(deps, job, { observed: acquired, holderWriters: true });
    }
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
    wiring: { leases?: Board['leases']; steps?: StepSink; endpoint?: SupervisorEndpoint } = {}
): Runner {
    const { leases, steps, endpoint } = wiring;
    const deps: K8sDeps = {
        config,
        request,
        sleep,
        ...(leases ? { leases } : {}),
        ...(steps ? { steps } : {}),
        ...(endpoint ? { endpoint } : {}),
    };
    return {
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
        adopt: (job: BoardJob, signal?: AbortSignal) =>
            adoptFinishedRunner(deps, job, { scrapeClaudeCloseRead, attachOpencodeOutcome }, signal),
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
        abandon: (job) => ledgerOf(deps).abandon(job),
        syncCheckout: (job: BoardJob, _signal?: AbortSignal, session?: RunSession | null, githubToken?: string) =>
            syncCheckout(deps, job, session ?? null, githubToken),
        finish: (job: BoardJob) => finishGroup(deps, job),
        reclaimWorktree: (job: BoardJob) => reclaimWorktree(deps, job),
        // The loop's hand-back of the checkout claim (`loop-fence.ts`) for an attempt that ends
        // without a group's end to give it back: a group still live keeps it for its `finish`
        // (issue #821), one whose end is unconfirmed keeps it for good.
        releaseFence: async (job: BoardJob) => {
            await releaseClaimAfterGroupEnd(deps, job);
        },
        // The orphaned-claim reap (issue #344): uid-preconditioned, by the claim's derivable
        // name — the fence's own GET/DELETE grants, nothing new.
        reapOrphanedClaim: (job: BoardJob, observed: ObservedClaim) => reapOrphanedClaim(deps, job, observed),
    };
}
