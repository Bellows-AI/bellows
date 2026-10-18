import type { BoardJob } from './board.js';
import type { ClaudeCloseRead } from './close-read.js';
import { mergeClaudeCloseRead } from './close-read.js';
import { CLAUDE_CODE, OPENCODE } from './executors.js';
import { jobsSelectorPath } from './k8s-auxspec.js';
import { acquireClaim, releaseClaimAfterGroupEnd, sweepClaimedFleets } from './k8s-fence.js';
import { finishedAgentRun, gateEnvSecretName, type ListedRunnerJob, runnerName, secretName } from './k8s-podspec.js';
import { deleteSecretAcked } from './k8s-teardown.js';
import { readRunnerVerdict, timedOutOf } from './k8s-poll.js';
import { expectOk, JOB_ID, parse } from './k8s-transport.js';
import type { K8sDeps, K8sJobStatus } from './k8s-transport.js';
import { CLAIM_SEQ_MARK, COMMAND_MARK, LEASE_LABEL, SESSION_MARK } from './labels.js';
import { AdoptionBlocked, type AdoptedRun, commandMark, type RunOutcome } from './runner.js';
import { adoptedVerdictOf, infraLossOf, type KillRecord, killEndsGroup, killRecordsOf } from './termination.js';

/** One runner Job of an earlier claim, as the label listing answers it. */
interface ListedRunner extends ListedRunnerJob {
    metadata?: { name?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
    status?: K8sJobStatus & { startTime?: string };
}

/** A finished runner of an earlier claim: the attempt it ran as, its claim sequence and session. */
interface EarlierRunner {
    prior: BoardJob;
    claimSeq: number;
    session: string | null;
    status: NonNullable<ListedRunner['status']>;
    /** Why its driver ended the run, as recorded on the Job before the kill (`recordRunnerKill`). */
    kills: KillRecord[];
}

/** The close-time readouts `run` performs, handed in by the runner that owns them. */
export interface CloseReads {
    scrapeClaudeCloseRead(deps: K8sDeps, job: BoardJob, sessionId: string, startedAt: string): Promise<ClaudeCloseRead>;
    attachOpencodeOutcome(deps: K8sDeps, job: BoardJob, startedAt: string, outcome: RunOutcome): Promise<void>;
}

/** One listed Job as a finished runner of a claim before `job`'s, or null when it is not one. */
function earlierRunnerOf(job: BoardJob, item: ListedRunner): EarlierRunner | null {
    const lease = item.metadata?.labels?.[LEASE_LABEL];
    const seq = item.metadata?.annotations?.[CLAIM_SEQ_MARK] ?? '';
    const status = item.status ?? {};
    if (!lease || !JOB_ID.test(lease) || !/^\d+$/.test(seq)) return null;
    // A queued task's command edited since the run (after a handover) makes that run not its own.
    if (item.metadata?.annotations?.[COMMAND_MARK] !== commandMark(job.command)) return null;
    const prior = { ...job, leaseToken: lease };
    // Only a finished agent run of the runner itself (its name is the (job, lease) hash, which no
    // aux Job shares): never a supervisor-only group, never a Job its driver suspended (issue #821).
    if (!finishedAgentRun(item, prior) || Number(seq) >= job.claimSeq) return null;
    const annotations = item.metadata.annotations;
    return {
        prior,
        claimSeq: Number(seq),
        session: annotations?.[SESSION_MARK] ?? null,
        status,
        kills: killRecordsOf(annotations),
    };
}

/** The newest finished runner Job of an earlier claim of this job, by claim sequence; null when none. */
async function finishedEarlierRunner(deps: K8sDeps, job: BoardJob): Promise<EarlierRunner | null> {
    const listed = await deps.request('GET', jobsSelectorPath(deps.config.k8sNamespace, job));
    expectOk(listed, 'listing the earlier runner jobs');
    let newest: EarlierRunner | null = null;
    for (const item of parse<{ items?: ListedRunner[] }>(listed.body).items ?? []) {
        const found = earlierRunnerOf(job, item);
        if (found && (!newest || found.claimSeq > newest.claimSeq)) newest = found;
    }
    return newest;
}

/** The earlier run's outcome, read the way `run` reads its own; null for a runner the platform took away. */
async function readEarlierRun(deps: K8sDeps, job: BoardJob, found: EarlierRunner, reads: CloseReads) {
    const { prior, session, status, kills } = found;
    const verdict = await readRunnerVerdict(deps, prior, (status.succeeded ?? 0) >= 1);
    const timedOut = timedOutOf(status) || verdict.supervisorDeadline || kills.some((k) => k.reason === 'timeout');
    const loss = infraLossOf({
        killedByDriver: kills.some((kill) => killEndsGroup(kill.reason)),
        timedOut,
        reported: false,
        vanished: verdict.vanished,
        unfinalized: verdict.unfinalized,
    });
    if (loss) return null;
    const { exitCode, output, fullLog, logTruncated } = verdict;
    const outcome: RunOutcome = {
        exitCode,
        output,
        timedOut,
        started: true,
        fullLog,
        logTruncated,
        ...adoptedVerdictOf(kills),
    };
    const startedAt = status.startTime ?? new Date(0).toISOString();
    if (job.executorType === OPENCODE) await reads.attachOpencodeOutcome(deps, prior, startedAt, outcome);
    if (job.executorType === CLAUDE_CODE && session) {
        mergeClaudeCloseRead(outcome, await reads.scrapeClaudeCloseRead(deps, prior, session, startedAt));
    }
    if (session && !outcome.sessionId) outcome.sessionId = session;
    return outcome;
}

/**
 * The kubernetes `Runner.adopt` (issue #792). The checkout claim is taken first, so no other
 * contender reads or sweeps the earlier runner alongside; its verdict, log and session are read
 * exactly as `run` reads its own; and only then is the earlier attempt's leftover swept — never an
 * unread runner. A runner the platform took away is no run to adopt: the claim goes back, and the
 * sync's re-claim fence takes it as ever.
 */
export async function adoptFinishedRunner(deps: K8sDeps, job: BoardJob, reads: CloseReads): Promise<AdoptedRun | null> {
    const found = await finishedEarlierRunner(deps, job);
    if (!found) return null;
    await acquireClaim(deps, job);
    try {
        const outcome = await readEarlierRun(deps, job, found, reads);
        if (!outcome) {
            await releaseClaimAfterGroupEnd(deps, job);
            return null;
        }
        // This attempt continues that outcome: its sweeps keep the run it read (issue #821).
        deps.adopted ??= new Map();
        deps.adopted.set(job.leaseToken, runnerName(found.prior));
        // The sweep spares the run it read — the evidence the next claim adopts if this one is lost
        // before its verdict lands (issue #821). Its Secrets go now; one that will not is cleanup for
        // later, never a reason to run again: the Job it is derived from stays listed as its anchor
        // for the reaper's Secret-first pass, and its owner reference takes it with the Job.
        try {
            await sweepClaimedFleets(deps, job);
        } catch (e) {
            // A leftover the sweep could not confirm gone may still write the tree: the read run is
            // not abandoned for a fresh one, the attempt stands down to its lease.
            throw new AdoptionBlocked(`the run was read, but ${(e as Error).message}`);
        }
        for (const name of [secretName(found.prior), gateEnvSecretName(found.prior)]) {
            await deleteSecretAcked(deps, name);
        }
        return { outcome, claimSeq: found.claimSeq };
    } catch (e) {
        deps.adopted?.delete(job.leaseToken);
        await releaseClaimAfterGroupEnd(deps, job);
        throw e;
    }
}
