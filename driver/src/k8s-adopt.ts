import type { BoardJob } from './board.js';
import type { ClaudeCloseRead } from './close-read.js';
import { mergeClaudeCloseRead } from './close-read.js';
import { CLAUDE_CODE, OPENCODE } from './executors.js';
import { jobPath, jobPodsPath, jobsSelectorPath, podLogPath } from './k8s-auxspec.js';
import { acquireClaim, readClaim, releaseClaimAfterGroupEnd, sweepClaimedFleets } from './k8s-fence.js';
import {
    agentRunJob,
    finishedAgentRun,
    type ListedRunnerJob,
    runnerJobName,
    runnerName,
    secretName,
} from './k8s-podspec.js';
import { isLease, validRunnerSpec } from './k8s-shapes.js';
import { deleteSecretAcked } from './k8s-teardown.js';
import {
    ABSENT,
    asJob,
    asNamed,
    asPod,
    jobOutcome,
    neverStartedLog,
    readList,
    readObject,
    readRunnerVerdict,
    readVerdict,
    runnerPodOf,
    timedOutOf,
} from './k8s-poll.js';
import { containerStatusOf, HTTP_BAD_REQUEST, HTTP_ERROR_STATUS, HTTP_NOT_FOUND, POLL_MS } from './k8s-transport.js';
import type { K8sDeps, K8sJobStatus, K8sPod, K8sResponse } from './k8s-transport.js';
import { CLAIM_SEQ_MARK, COMMAND_MARK, isCommandMark, isSeq, LEASE_LABEL, SESSION_MARK } from './labels.js';
import {
    AdoptionBlocked,
    type AdoptedRun,
    adoptionAbandoned,
    commandMark,
    Inconclusive,
    type RunOutcome,
} from './runner.js';
import {
    AGENT_CONTAINER,
    type FinalReport,
    finalReportOf,
    SUPERVISOR_CONTAINER,
    SUPERVISOR_WINDDOWN_MS,
} from './supervisor-contract.js';
import { type KillRecord, killRecordsOf, settleEnd } from './termination.js';

/** One runner Job of an earlier claim, as the label listing answers it. */
interface ListedRunner extends ListedRunnerJob {
    metadata?: { name?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
    status?: K8sJobStatus & { startTime?: string };
}

/** An agent runner of an earlier claim: the attempt it ran as, its claim sequence and session. */
interface EarlierRunner {
    prior: BoardJob;
    claimSeq: number;
    session: string | null;
    status: NonNullable<ListedRunner['status']>;
    /** The Job is over; otherwise its agent may have exited while its supervisor finalizes (#824). */
    finished: boolean;
    /** Why its driver ended the run, as recorded on the Job before the kill (`recordRunnerKill`). */
    kills: KillRecord[];
}

/** The close-time readouts `run` performs, handed in by the runner that owns them. */
export interface CloseReads {
    scrapeClaudeCloseRead(deps: K8sDeps, job: BoardJob, sessionId: string, startedAt: string): Promise<ClaudeCloseRead>;
    attachOpencodeOutcome(deps: K8sDeps, job: BoardJob, startedAt: string, outcome: RunOutcome): Promise<void>;
}

/**
 * One listed Job as an agent runner of a claim before `job`'s, or null when it is not one. The
 * markers an adoption orders and recognizes by are valid when the Job is a runner's
 * (`asListedRunner`): a Job whose command mark is another valid mark is another command's run.
 */
function earlierRunnerOf(job: BoardJob, item: ListedRunner): EarlierRunner | null {
    const prior = { ...job, leaseToken: item.metadata?.labels?.[LEASE_LABEL] ?? '' };
    const annotations = item.metadata?.annotations;
    // Only an agent run of the runner itself (its name is the (job, lease) hash, which no aux Job
    // shares): never a supervisor-only group, never a Job its driver suspended (issue #821).
    if (!agentRunJob(item, prior)) return null;
    // A queued task's command edited since the run (after a handover) makes that run not its own.
    if (annotations?.[COMMAND_MARK] !== commandMark(job.command)) return null;
    const claimSeq = Number(annotations?.[CLAIM_SEQ_MARK]);
    if (claimSeq >= job.claimSeq) return null;
    return {
        prior,
        claimSeq,
        session: annotations?.[SESSION_MARK] ?? null,
        status: item.status ?? {},
        finished: finishedAgentRun(item, prior),
        kills: killRecordsOf(annotations),
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

/** A typed read whose `Inconclusive` stands the adoption down: nothing unconfirmed decides a run (#824). */
async function confirmed<T>(read: Promise<T>): Promise<T> {
    try {
        return await read;
    } catch (e) {
        if (e instanceof Inconclusive) throw new AdoptionBlocked(e.message);
        throw e;
    }
}

/** The runner pods of `prior`, read with the verdict reads' patience; none for a list the apiserver has not. */
async function runnerPodsOf(deps: K8sDeps, prior: BoardJob): Promise<K8sPod[]> {
    const path = jobPodsPath(deps.config.k8sNamespace, runnerName(prior));
    const pods = await confirmed(readList(deps, path, 'listing the earlier runner pods', { entry: asPod }));
    return pods === ABSENT ? [] : pods;
}

/** The earlier runners of this job, listed with the verdict reads' patience. */
async function listEarlierRunners(deps: K8sDeps, job: BoardJob): Promise<ListedRunner[]> {
    const path = jobsSelectorPath(deps.config.k8sNamespace, job);
    const runners = await confirmed(
        readList(deps, path, 'listing the earlier runner jobs', { entry: asListedRunner(job) })
    );
    return runners === ABSENT ? [] : runners;
}

/**
 * The newest earlier runner a claim may adopt, by claim sequence: a finished one, or one whose
 * agent exited while its supervisor finalizes (#824) — a Job listed over whose supervisor still
 * runs is that too. A runner whose agent still runs is skipped, as ever.
 */
async function adoptableEarlierRunner(deps: K8sDeps, job: BoardJob): Promise<EarlierRunner | null> {
    const runners = (await listEarlierRunners(deps, job))
        .map((item) => earlierRunnerOf(job, item))
        .filter((found): found is EarlierRunner => found !== null)
        .sort((a, b) => b.claimSeq - a.claimSeq);
    for (const found of runners) {
        const pods = await runnerPodsOf(deps, found.prior);
        if (found.finished) return { ...found, finished: groupStateOf(pods) === 'over' };
        if (containerStatusOf(runnerPodOf(pods), AGENT_CONTAINER)?.state?.terminated) return found;
    }
    return null;
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
 * Waits out a supervisor finalizing after its agent exited (#824), bounded in time by the wind-down
 * its own drain and report take. Answers the Job's terminal status once its pod is over too; null
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

async function awaitFinalized(deps: K8sDeps, prior: BoardJob, signal?: AbortSignal): Promise<Ended | null> {
    let confirmed = false;
    const started = Date.now();
    // In time, not polls: a status read that is slow spends the bound as well.
    for (let polls = 0; Math.max(polls * POLL_MS, Date.now() - started) < SUPERVISOR_WINDDOWN_MS; polls += 1) {
        if (signal?.aborted) throw adoptionAbandoned();
        const now = await finalizingNow(deps, prior);
        if (now === 'gone') return null;
        if (typeof now === 'object') return now;
        confirmed = now === 'running';
        await deps.sleep(POLL_MS);
    }
    if (signal?.aborted) throw adoptionAbandoned();
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
        log = await readVerdict(
            deps,
            podLogPath(ns, pod.metadata.name, undefined, SUPERVISOR_CONTAINER),
            'reading the earlier supervisor log'
        );
    } catch (e) {
        throw new AdoptionBlocked(`the earlier supervisor's report could not be read: ${(e as Error).message}`);
    }
    if (log.status === HTTP_NOT_FOUND || (log.status === HTTP_BAD_REQUEST && neverStartedLog(log.body))) {
        return { report: null, neverRan: null };
    }
    if (log.status >= HTTP_ERROR_STATUS) {
        throw new AdoptionBlocked(`the earlier supervisor's report could not be read: HTTP ${log.status}`);
    }
    return { report: finalReportOf(log.body), neverRan: null };
}

/** The earlier run's outcome, read the way `run` reads its own; null for a runner the platform took away. */
async function readEarlierRun(deps: K8sDeps, job: BoardJob, found: EarlierRunner, reads: CloseReads) {
    const { prior, session, status, kills } = found;
    const { report, neverRan } = await readFinalReport(deps, prior);
    const verdict = await confirmed(
        readRunnerVerdict(deps, prior, (status.succeeded ?? 0) >= 1, { report, strict: true })
    );
    // A supervisor that reported finalized the run: the pod's deletion after it is no loss.
    const { timedOut, infraLoss, fields } = settleEnd({
        kills,
        driverKilledHard: false,
        report,
        budgetEnded: timedOutOf(status) || verdict.supervisorDeadline,
        vanished: verdict.vanished,
        unfinalized: verdict.unfinalized ?? neverRan,
    });
    if (infraLoss) return null;
    const { exitCode, output, fullLog, logTruncated } = verdict;
    const outcome: RunOutcome = {
        exitCode,
        output,
        timedOut,
        started: true,
        fullLog,
        logTruncated,
        ...fields,
    };
    const startedAt = status.startTime ?? new Date(0).toISOString();
    if (job.executorType === OPENCODE) await reads.attachOpencodeOutcome(deps, prior, startedAt, outcome);
    if (job.executorType === CLAUDE_CODE && session) {
        mergeClaudeCloseRead(outcome, await reads.scrapeClaudeCloseRead(deps, prior, session, startedAt));
    }
    if (session && !outcome.sessionId) outcome.sessionId = session;
    return outcome;
}

/** `adoptableEarlierRunner`, contained: whatever it meets in what it reads stands the attempt down, never a fresh run. */
async function discovered(deps: K8sDeps, job: BoardJob): Promise<EarlierRunner | null> {
    try {
        return await adoptableEarlierRunner(deps, job);
    } catch (e) {
        if (e instanceof AdoptionBlocked) throw e;
        throw new AdoptionBlocked(`the earlier runners could not be read: ${(e as Error).message}`);
    }
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
export async function adoptFinishedRunner(
    deps: K8sDeps,
    job: BoardJob,
    reads: CloseReads,
    signal?: AbortSignal
): Promise<AdoptedRun | null> {
    const found = await discovered(deps, job);
    if (!found) return null;
    try {
        return await adoptFound(deps, job, found, { reads, signal });
    } catch (e) {
        deps.adopted?.delete(job.leaseToken);
        await releaseClaimAfterGroupEnd(deps, job);
        // An earlier run exists: no throw may fall through to a fresh run, whose sync's fence would
        // sweep it unread — the attempt stands down to its lease instead.
        if (e instanceof AdoptionBlocked || signal?.aborted) throw e;
        throw new AdoptionBlocked(`the earlier run could not be adopted: ${(e as Error).message}`);
    }
}

/** `adoptFinishedRunner` over the earlier runner it found; its caller gives the claim back on any throw. */
async function adoptFound(
    deps: K8sDeps,
    job: BoardJob,
    found: EarlierRunner,
    { reads, signal }: { reads: CloseReads; signal: AbortSignal | undefined }
): Promise<AdoptedRun | null> {
    // A takeover of a stale claim deletes it: never once the attempt stood down.
    if (signal?.aborted) throw adoptionAbandoned();
    await acquireClaim(deps, job);
    if (!found.finished) {
        const ended = await awaitFinalized(deps, found.prior, signal);
        if (!ended) {
            await releaseClaimAfterGroupEnd(deps, job);
            return null;
        }
        found.status = { ...found.status, ...ended.status };
        found.kills = ended.kills;
    }
    const outcome = await readEarlierRun(deps, job, found, reads);
    if (!outcome) {
        await releaseClaimAfterGroupEnd(deps, job);
        return null;
    }
    // This attempt continues that outcome: its sweeps keep the run it read (issue #821).
    deps.adopted ??= new Map();
    deps.adopted.set(job.leaseToken, runnerName(found.prior));
    // Nothing is deleted once the attempt stood down, whatever the run it read.
    if (signal?.aborted) throw adoptionAbandoned();
    if (!found.finished) await assertClaimStillHeld(deps, job);
    await sweepAfterAdoption(deps, job, found.prior, signal);
    return { outcome, claimSeq: found.claimSeq };
}

/**
 * The sweep spares the run it read — the evidence the next claim adopts if this one is lost
 * before its verdict lands (issue #821). Its Secrets go now; one that will not is cleanup for
 * later, never a reason to run again: the Job it is derived from stays listed as its anchor for
 * the reaper's Secret-first pass, and its owner reference takes it with the Job.
 */
async function sweepAfterAdoption(deps: K8sDeps, job: BoardJob, prior: BoardJob, signal?: AbortSignal): Promise<void> {
    try {
        await sweepClaimedFleets(deps, job, 0, signal);
    } catch (e) {
        if (signal?.aborted) throw adoptionAbandoned();
        // A leftover the sweep could not confirm gone may still write the tree: the read run is
        // not abandoned for a fresh one, the attempt stands down to its lease.
        throw new AdoptionBlocked(`the run was read, but ${(e as Error).message}`);
    }
    if (signal?.aborted) throw adoptionAbandoned();
    await deleteSecretAcked(deps, secretName(prior));
}
