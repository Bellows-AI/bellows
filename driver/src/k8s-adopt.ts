import type { BoardJob } from './board.js';
import type { ClaudeCloseRead } from './close-read.js';
import { mergeClaudeCloseRead } from './close-read.js';
import { CLAUDE_CODE, OPENCODE } from './executors.js';
import { jobPath, jobPodsPath, jobsSelectorPath, podLogPath } from './k8s-auxspec.js';
import { acquireClaim, readClaim, releaseClaimAfterGroupEnd, sweepClaimedFleets } from './k8s-fence.js';
import { groupsOf } from './k8s-group.js';
import {
    agentRunJob,
    finishedAgentRun,
    type ListedRunnerJob,
    runnerJobName,
    runnerName,
    secretName,
} from './k8s-podspec.js';
import { isLease, validRunnerSpec } from './k8s-shapes.js';
import { ledgerOf } from './k8s-kill.js';
import { deleteSecretAcked } from './k8s-teardown.js';
import { asNamed, asPod } from './k8s-pod-shapes.js';
import {
    ABSENT,
    asJob,
    jobOutcome,
    logIsNone,
    readList,
    readObject,
    readRunnerVerdict,
    readLogVerdict,
    runnerPodOf,
    timedOutOf,
} from './k8s-poll.js';
import { boundedBy, containerStatusOf, HTTP_ERROR_STATUS, POLL_MS, waitOf, withSignal } from './k8s-transport.js';
import { anyOf } from './poll.js';
import { pollFor } from './poll.js';
import type { K8sDeps, K8sJobStatus, K8sPod, K8sResponse } from './k8s-transport.js';
import { CLAIM_SEQ_MARK, COMMAND_MARK, isCommandMark, isSeq, LEASE_LABEL, SESSION_MARK } from './labels.js';
import {
    AdoptionBlocked,
    type AdoptedRun,
    adoptionAbandoned,
    Inconclusive,
    type LiveRun,
    type RunOutcome,
} from './runner.js';
import {
    AGENT_CONTAINER,
    type FinalReport,
    finalReportOf,
    SUPERVISOR_CONTAINER,
    SUPERVISOR_RELEASED_LINE,
} from './supervisor-contract.js';
import { type AdoptPrimitives, adoptEarlierRun, type EarlierRun } from './adopt-skeleton.js';
import { finalizeWaitMs } from './supervisor-plan.js';
import { type KillRecord, killRecordsOf, reportFinalized } from './termination.js';

/** One runner Job of an earlier claim, as the label listing answers it. */
interface ListedRunner extends ListedRunnerJob {
    metadata?: { name?: string; uid?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
    status?: K8sJobStatus & { startTime?: string };
}

/** An agent runner of an earlier claim: the attempt it ran as, its claim sequence and session. */
interface EarlierRunner extends EarlierRun {
    status: NonNullable<ListedRunner['status']>;
    /** The Job is over; otherwise its agent may have exited while its supervisor finalizes (#824). */
    finished: boolean;
    /** Why its driver ended the run, as recorded on the Job before the kill (`recordRunnerKill`). */
    kills: KillRecord[];
    /** The incarnation listed, which a taken-over group's teardown deletes (#829). */
    uid: string | undefined;
    /** A released group taken over: when it started, and the incarnation (#829). */
    live?: { startedAt: string; uid: string };
}

/** The close-time readouts `run` performs, handed in by the runner that owns them. */
export interface CloseReads {
    scrapeClaudeCloseRead(deps: K8sDeps, job: BoardJob, sessionId: string, startedAt: string): Promise<ClaudeCloseRead>;
    attachOpencodeOutcome(deps: K8sDeps, job: BoardJob, startedAt: string, outcome: RunOutcome): Promise<void>;
}

/**
 * One listed Job as an agent runner of this job, or null when it is not one. The markers an adoption
 * orders and recognizes by are valid when the Job is a runner's (`asListedRunner`); the skeleton
 * drops a Job of a later claim or whose command mark is another valid mark (another command's run).
 */
function earlierRunnerOf(job: BoardJob, item: ListedRunner): EarlierRunner | null {
    const prior = { ...job, leaseToken: item.metadata?.labels?.[LEASE_LABEL] ?? '' };
    const annotations = item.metadata?.annotations;
    // Only an agent run of the runner itself (its name is the (job, lease) hash, which no aux Job
    // shares): never a supervisor-only group, never a Job its driver suspended (issue #821).
    if (!agentRunJob(item, prior)) return null;
    return {
        prior,
        claimSeq: Number(annotations?.[CLAIM_SEQ_MARK]),
        commandMark: annotations?.[COMMAND_MARK],
        session: annotations?.[SESSION_MARK] ?? null,
        status: item.status ?? {},
        finished: finishedAgentRun(item, prior),
        kills: killRecordsOf(annotations),
        uid: item.metadata?.uid,
    };
}

/** A runner pod that ran to its end — `Succeeded` or `Failed` — writes nothing any more. */
const FINISHED_PHASES: readonly string[] = ['Succeeded', 'Failed'];

/**
 * Where a runner's group stands by its listed pods: `over` once every pod ran to its end or its
 * supervisor terminated; `finalizing` while a pod's supervisor is said to run; `unknown` for a pod
 * not over that says nothing of its supervisor. The Job controller can mark a Job failed
 * (`FailureTarget`) before its pod is over, so a Job's outcome alone is no end of its group.
 */
function groupStateOf(pods: K8sPod[]): 'over' | 'finalizing' | 'unknown' {
    let state: 'over' | 'unknown' = 'over';
    for (const pod of pods) {
        if (FINISHED_PHASES.includes(pod.status?.phase ?? '')) continue;
        const supervisor = containerStatusOf(pod, SUPERVISOR_CONTAINER)?.state;
        if (supervisor === undefined) state = 'unknown';
        else if (!supervisor.terminated) return 'finalizing';
    }
    return state;
}

/**
 * A listed Job of this job, as far as an adoption reads it (#869): one that names itself and its
 * lease — every Job the driver creates carries one. A Job named as the runner of that lease also
 * carries the markers an adoption orders and recognizes it by — a claim sequence in digits within the
 * safe integers, a command mark — and a spec that says whether it runs an agent; without them it
 * cannot be told apart from "no earlier run", so the adoption is blocked rather than skipping it.
 */
const asListedRunner =
    (job: BoardJob) =>
    (value: unknown): ListedRunner | null => {
        const item = asNamed<ListedRunner>(value);
        const lease = item?.metadata?.labels?.[LEASE_LABEL];
        if (!item || !isLease(lease)) return null;
        if (item.metadata?.name !== runnerJobName({ ...job, leaseToken: lease })) return item;
        const annotations = item.metadata.annotations;
        const marked = isSeq(annotations?.[CLAIM_SEQ_MARK]) && isCommandMark(annotations?.[COMMAND_MARK]);
        return marked && validRunnerSpec(item.spec) ? item : null;
    };

/** The runner pods of `prior`, read with the verdict reads' patience; none for a list the apiserver has not. */
async function runnerPodsOf(deps: K8sDeps, prior: BoardJob): Promise<K8sPod[]> {
    const path = jobPodsPath(deps.config.k8sNamespace, runnerName(prior));
    const pods = await readList(deps, path, 'listing the earlier runner pods', { entry: asPod });
    return pods === ABSENT ? [] : pods;
}

/** The earlier runners of this job, listed with the verdict reads' patience. */
async function listEarlierRunners(deps: K8sDeps, job: BoardJob): Promise<ListedRunner[]> {
    const path = jobsSelectorPath(deps.config.k8sNamespace, job);
    const runners = await readList(deps, path, 'listing the earlier runner jobs', { entry: asListedRunner(job) });
    return runners === ABSENT ? [] : runners;
}

/**
 * Whether an earlier runner (newest first) is one a claim may adopt: a finished one, or one whose
 * agent exited while its supervisor finalizes (#824) — a Job listed over whose supervisor still
 * runs is that too — or a group its supervisor RELEASED whose agent still runs, taken over (#829).
 * A group not released is skipped, as ever: it is redone.
 */
async function admitted(deps: K8sDeps, found: EarlierRunner): Promise<EarlierRunner | null> {
    const pods = await runnerPodsOf(deps, found.prior);
    if (found.finished) return { ...found, finished: groupStateOf(pods) === 'over' };
    const pod = runnerPodOf(pods);
    if (containerStatusOf(pod, AGENT_CONTAINER)?.state?.terminated) return found;
    if (!(await releasedRunning(deps, found, pod))) return null;
    if (found.uid === undefined)
        throw new AdoptionBlocked('the earlier runner Job lists without a uid to tear down by');
    return { ...found, live: { startedAt: startedAtOf(found), uid: found.uid } };
}

const startedAtOf = ({ status }: EarlierRunner): string => status.startTime ?? new Date(0).toISOString();

/**
 * Whether the pod is a released group still running: its agent and supervisor run and the supervisor
 * logged the release (`SUPERVISOR_RELEASED_LINE`). A pod that is not up yet, or whose agent was not
 * released, is none. A running pod whose container states are unread, or a log the apiserver would
 * not serve, proves nothing and blocks the adoption: redoing would sweep a run that may be live.
 */
async function releasedRunning(deps: K8sDeps, found: EarlierRunner, pod: K8sPod | undefined): Promise<boolean> {
    if (pod?.status?.phase !== 'Running') return false;
    const agent = containerStatusOf(pod, AGENT_CONTAINER)?.state;
    const supervisor = containerStatusOf(pod, SUPERVISOR_CONTAINER)?.state;
    if (agent === undefined || supervisor === undefined) {
        throw new AdoptionBlocked('the earlier runner pod is running but its container states could not be read');
    }
    if (!agent.running || !supervisor.running || !pod.metadata?.name) return false;
    let log: K8sResponse;
    try {
        log = await readLogVerdict(
            deps,
            podLogPath(deps.config.k8sNamespace, pod.metadata.name, null, SUPERVISOR_CONTAINER),
            'reading the earlier supervisor log'
        );
    } catch (e) {
        throw new AdoptionBlocked(`the earlier supervisor's release could not be read: ${(e as Error).message}`);
    }
    if (log.status >= HTTP_ERROR_STATUS || logIsNone(log)) {
        throw new AdoptionBlocked(`the earlier supervisor's release could not be read: HTTP ${log.status}`);
    }
    return log.body.split('\n').some((line) => line.trim() === SUPERVISOR_RELEASED_LINE);
}

/** Whether the runner pods read now show the group over; null when the list proves nothing. */
async function groupOver(deps: K8sDeps, prior: BoardJob): Promise<boolean | null> {
    const path = jobPodsPath(deps.config.k8sNamespace, runnerName(prior));
    const pods = await readList(deps, path, 'listing the finalizing runner pods', { entry: asPod, once: true }).catch(
        (e: unknown) => {
            if (e instanceof Inconclusive) return null;
            throw e;
        }
    );
    if (pods === null) return null;
    const state = pods === ABSENT ? 'over' : groupStateOf(pods);
    return state === 'unknown' ? null : state === 'over';
}

/**
 * Waits out a supervisor finalizing after its agent exited (#824), bounded in time by
 * `finalizeWaitMs`: the wind-down its own drain and report take, and what a released group may wait
 * for a holder (#829). Answers the Job's terminal status once its pod is over too; null
 * when the Job is gone (taken away) or confirmed still running at the bound — the sweep's then, as
 * the docker twin leaves it. Each poll is one read, never the verdict reads' retries, so an
 * apiserver that does not answer spends the bound and no more; a bound that ends on reads that
 * never answered is no confirmation, and the attempt stands down.
 */
/** A finalizing runner's Job once it is over: its terminal status, and the kill records it carries then. */
interface Ended {
    status: K8sJobStatus;
    kills: KillRecord[];
}

export async function awaitFinalized(deps: K8sDeps, prior: BoardJob, signal: AbortSignal): Promise<Ended | null> {
    let confirmed = false;
    // In time, not polls: a status read that is slow spends the bound as well.
    const live = withSignal(deps, signal);
    const ended = await pollFor<Ended | 'gone'>(
        { ...waitOf(live, finalizeWaitMs(deps.config)), everyMs: POLL_MS, abandoned: adoptionAbandoned },
        async (deadline) => {
            const now = await finalizingNow(boundedBy(live, deadline), prior);
            if (now === 'gone' || typeof now === 'object') return now;
            confirmed = now === 'running';
        }
    );
    if (ended === 'gone') return null;
    if (ended) return ended;
    if (signal.aborted) throw adoptionAbandoned();
    if (!confirmed) throw new AdoptionBlocked('the finalizing runner could not be read to its end');
    return null;
}

/** One poll of a finalizing runner: over (its terminal status), gone, still running, or unknown (a read that proves nothing). */
async function finalizingNow(deps: K8sDeps, prior: BoardJob): Promise<Ended | 'gone' | 'running' | 'unknown'> {
    const path = jobPath(deps.config.k8sNamespace, runnerName(prior));
    const job = await readObject(deps, path, 'reading the finalizing runner', { shape: asJob, once: true }).catch(
        (e: unknown) => {
            if (e instanceof Inconclusive) return null;
            throw e;
        }
    );
    if (job === ABSENT) return 'gone';
    if (job === null) return 'unknown';
    const status = job.status ?? {};
    if (jobOutcome(status) === 'pending') return 'running';
    const over = await groupOver(deps, prior);
    if (over === null) return 'unknown';
    // The lost driver may have recorded why it ended the run while this claim waited.
    return over ? { status, kills: killRecordsOf(job.metadata?.annotations) } : 'running';
}

/** The terminated reasons of a container the kubelet could not start. */
const START_FAILURES: readonly string[] = ['StartError', 'ContainerCannotRun'];

/**
 * Why a runner pod's supervisor never ran, or null when it did (or nothing says): the pod is over
 * and its supervisor container is listed without ever running, or the kubelet refused the pod
 * before any container started (`UnexpectedAdmissionError` and the like). Such a group has no log
 * to read and nothing finalized it: the platform took it away.
 */
function supervisorNeverRan(pod: K8sPod | undefined): string | null {
    if (!pod || !FINISHED_PHASES.includes(pod.status?.phase ?? '')) return null;
    const supervisor = containerStatusOf(pod, SUPERVISOR_CONTAINER)?.state;
    const { terminated } = supervisor ?? {};
    // A container the kubelet could not start reads terminated with the reason, never having run.
    const startFailed =
        terminated !== undefined && START_FAILURES.includes(terminated.reason ?? '') && !terminated.startedAt;
    if (supervisor?.running || (terminated && !startFailed)) return null;
    if (supervisor === undefined && pod.status?.reason === undefined) return null;
    const said = startFailed ? [terminated.reason, terminated.message] : [pod.status?.reason, pod.status?.message];
    const detail = said.filter(Boolean).join(': ');
    return `the runner pod ended before its supervisor started (${detail || 'never started'})`;
}

/**
 * The supervisor's final report, from its log; null when it logged none, or its pod or container is
 * gone, or it never ran (`neverRan`). A log the apiserver would not serve, past the verdict reads'
 * patience, is no answer — taken for "no report" it would make a supervisor that reported and then
 * crashed a loss, and the run swept unread — so the attempt stands down instead.
 */
async function readFinalReport(
    deps: K8sDeps,
    prior: BoardJob
): Promise<{ report: FinalReport | null; neverRan: string | null }> {
    const ns = deps.config.k8sNamespace;
    let log: K8sResponse;
    try {
        const listed = await readList(deps, jobPodsPath(ns, runnerName(prior)), 'listing the earlier runner pods', {
            entry: asPod,
        });
        const pod = runnerPodOf(listed === ABSENT ? [] : listed);
        const neverRan = supervisorNeverRan(pod);
        if (!pod?.metadata?.name || neverRan) return { report: null, neverRan };
        log = await readLogVerdict(
            deps,
            podLogPath(ns, pod.metadata.name, undefined, SUPERVISOR_CONTAINER),
            'reading the earlier supervisor log'
        );
    } catch (e) {
        throw new AdoptionBlocked(`the earlier supervisor's report could not be read: ${(e as Error).message}`);
    }
    if (logIsNone(log)) {
        return { report: null, neverRan: null };
    }
    if (log.status >= HTTP_ERROR_STATUS) {
        throw new AdoptionBlocked(`the earlier supervisor's report could not be read: HTTP ${log.status}`);
    }
    return { report: finalReportOf(log.body), neverRan: null };
}

/** Before anything is deleted after a wait: the checkout claim is still this attempt's. */
async function assertClaimStillHeld(deps: K8sDeps, job: BoardJob): Promise<void> {
    if ((await readClaim(deps, job))?.holder !== job.leaseToken) {
        throw new AdoptionBlocked('the checkout claim was taken over while the earlier runner finalized');
    }
}

/**
 * The kubernetes `Runner.adopt` (issue #792). The checkout claim is taken first, so no other
 * contender reads or sweeps the earlier runner alongside; a runner whose supervisor is still
 * finalizing is waited out (#824); its verdict, log and session are read exactly as `run` reads its
 * own; and only then is the earlier attempt's leftover swept — never an unread runner. A runner the
 * platform took away is no run to adopt: the claim goes back, and the sync's re-claim fence takes
 * it as ever. `signal` is the attempt's stand-down: an abandoned adoption deletes nothing.
 */
export function adoptFinishedRunner(
    deps: K8sDeps,
    job: BoardJob,
    reads: CloseReads,
    signal?: AbortSignal
): Promise<AdoptedRun | LiveRun | null> {
    // This attempt continues the run it reads: its sweeps keep it (issue #821).
    deps.adopted ??= new Map();
    // The supplied stand-down and the attempt's kill end every request and pause of the adoption.
    return adoptEarlierRun(k8sAdoption(deps, reads), deps.adopted, job, anyOf(signal, ledgerOf(deps).signal(job)));
}

/** What differs in kubernetes' adoption: the Job listing, the checkout claim, the pod reads, the sweep. */
function k8sAdoption(deps: K8sDeps, reads: CloseReads): AdoptPrimitives<EarlierRunner> {
    return {
        list: async (job, { deadline, signal }) =>
            (await listEarlierRunners(withSignal(boundedBy(deps, deadline), signal), job))
                .map((item) => earlierRunnerOf(job, item))
                .filter((found): found is EarlierRunner => found !== null),
        admit: (found, _job, signal) => admitted(withSignal(deps, signal), found),
        begin: (job, signal) => acquireClaim(withSignal(deps, signal), job),
        awaitEnd: async (found, _job, signal) => {
            if (found.finished) return found;
            const ended = await awaitFinalized(deps, found.prior, anyOf(signal));
            return ended && { ...found, status: { ...found.status, ...ended.status }, kills: ended.kills };
        },
        read: async (found, _job, signal) => {
            const { prior, status, kills } = found;
            const live = withSignal(deps, signal);
            const { report, neverRan } = await readFinalReport(live, prior);
            const verdict = await readRunnerVerdict(live, prior, (status.succeeded ?? 0) >= 1, {
                report,
                strict: true,
            });
            const { exitCode, output, fullLog, logTruncated } = verdict;
            return {
                // A supervisor that reported finalized the run: the pod's deletion after it is no loss.
                end: {
                    kills,
                    driverKilledHard: false,
                    report,
                    budgetEnded: timedOutOf(status) || verdict.supervisorDeadline,
                    vanished: reportFinalized(report) ? null : verdict.vanished,
                    unfinalized: verdict.unfinalized ?? neverRan,
                },
                body: async () => ({
                    exitCode,
                    output,
                    fullLog,
                    logTruncated,
                    startedAt: status.startTime ?? new Date(0).toISOString(),
                }),
            };
        },
        // Before anything is deleted after a wait: the checkout claim is still this attempt's.
        confirmOwnership: async (found, job, signal) => {
            if (!found.finished) await assertClaimStillHeld(withSignal(deps, signal), job);
        },
        closeReadout: async (outcome, { prior, session }, job, { startedAt, signal }) => {
            const live = withSignal(deps, signal);
            if (job.executorType === OPENCODE) await reads.attachOpencodeOutcome(live, prior, startedAt, outcome);
            if (job.executorType === CLAUDE_CODE && session) {
                mergeClaudeCloseRead(outcome, await reads.scrapeClaudeCloseRead(live, prior, session, startedAt));
            }
        },
        recordKey: ({ prior }) => runnerName(prior),
        sweep: ({ prior, live }, job, signal) => sweepAfterAdoption(deps, job, prior, signal, live !== undefined),
        rollback: async (job) => {
            await releaseClaimAfterGroupEnd(deps, job);
        },
        adoptLive: ({ prior, session, live }) => {
            if (!live) return () => undefined;
            // The group's end is this process's from here, as if it had created it (`resumed`: it created nothing).
            groupsOf(deps).set(prior.leaseToken, {
                startedAt: live.startedAt,
                session: session ? { id: session, resume: true } : null,
                agent: true,
                uids: { job: live.uid },
                resumed: true,
            });
            return () => {
                groupsOf(deps).delete(prior.leaseToken);
            };
        },
    };
}

/**
 * The sweep spares the run it read — the evidence the next claim adopts if this one is lost
 * before its verdict lands (issue #821). Its Secrets go now; one that will not is cleanup for
 * later, never a reason to run again: the Job it is derived from stays listed as its anchor for
 * the reaper's Secret-first pass, and its owner reference takes it with the Job.
 */
async function sweepAfterAdoption(
    deps: K8sDeps,
    job: BoardJob,
    prior: BoardJob,
    signal?: AbortSignal,
    live = false
): Promise<void> {
    try {
        await sweepClaimedFleets(deps, job, signal ?? ledgerOf(deps).signal(job));
    } catch (e) {
        if (signal?.aborted) throw adoptionAbandoned();
        // A leftover the sweep could not confirm gone may still write the tree: the read run is
        // not abandoned for a fresh one, the attempt stands down to its lease.
        throw new AdoptionBlocked(`the run was read, but ${(e as Error).message}`);
    }
    if (signal?.aborted) throw adoptionAbandoned();
    // A live group's Secret carries the binding it follows and the env it runs with: it is never deleted.
    if (!live) await deleteSecretAcked(deps, secretName(prior));
}
