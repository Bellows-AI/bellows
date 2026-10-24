import type { BoardJob } from './board/board.js';
import {
    type AdoptedRun,
    AdoptionBlocked,
    adoptionAbandoned,
    commandMark,
    Inconclusive,
    type LiveRun,
    type RunOutcome,
} from './runner.js';
import { type Bound, pollFor, type Sleep } from './poll.js';
import { type EndEvidence, settleEnd } from './termination.js';

/** An earlier run of this job as an executor lists it: the attempt it ran as and what orders and recognizes it. */
export interface EarlierRun {
    prior: BoardJob;
    claimSeq: number;
    /** The command mark it was created under; another valid mark is another command's run. */
    commandMark: string | undefined;
    session: string | null;
    /** Set by `admit` for a released group whose agent still runs (#829): taken over, never read as an end. */
    live?: { startedAt: string };
}

/** What the earlier run's exit and log say, read only once its end is known to be a run to adopt. */
export interface EarlierBody {
    exitCode: number | null;
    output: string;
    fullLog: string;
    logTruncated: boolean;
    startedAt: string;
}

/** The earlier run's end evidence, and the lazy read of its body (a lost run's body is never read). */
export interface EarlierRead {
    end: EndEvidence;
    body(): Promise<EarlierBody>;
}

/**
 * What differs between the executors' adoptions. Every primitive may throw `Inconclusive` (a read
 * that proved nothing), which the skeleton makes `AdoptionBlocked`: an earlier run exists, so no
 * throw may fall through to a fresh run whose fence would sweep it unread.
 */
export interface AdoptPrimitives<F extends EarlierRun> {
    /** The listing is tried this often, `retryMs` apart, before the attempt stands down; docker's pace. */
    pacing?: { attempts: number; retryMs: number; sleep: Sleep };
    /** `bound`: the deadline and stand-down of the paced wait the listing runs in; its requests end by both. */
    list(job: BoardJob, bound: Bound): Promise<F[]>;
    /** Whether a candidate (newest first) is a run to adopt at all; null skips it. Default: it is. */
    admit?(found: F, job: BoardJob, signal: AbortSignal | undefined): Promise<F | null>;
    /** Before anything is read or deleted: kubernetes takes the checkout claim, docker has none. */
    begin(job: BoardJob, signal: AbortSignal | undefined): Promise<void>;
    /** Waits out a supervisor still finalizing; null when the run is gone or still running. */
    awaitEnd(found: F, job: BoardJob, signal: AbortSignal | undefined): Promise<F | null>;
    read(found: F, job: BoardJob, signal: AbortSignal | undefined): Promise<EarlierRead>;
    /** After the wait and the reads, before the run is kept or anything swept: the claim is still this attempt's. */
    confirmOwnership(found: F, job: BoardJob, signal: AbortSignal | undefined): Promise<void>;
    closeReadout(
        outcome: RunOutcome,
        found: F,
        job: BoardJob,
        read: { startedAt: string; signal: AbortSignal | undefined }
    ): Promise<void>;
    /** The value the `adopted` map keeps: the run a sweep of this attempt spares. */
    recordKey(found: F): string;
    /** Takes away what older attempts left (never the run read). */
    sweep(found: F, job: BoardJob, signal: AbortSignal | undefined): Promise<void>;
    /** Gives back what `begin` took. */
    rollback(job: BoardJob): Promise<void>;
    /** A live run taken over: this driver's memory of its group, recorded under the prior lease; answers the undo. */
    adoptLive(found: F): () => void;
}

/** A throw that stands the attempt down to its lease: already blocked, an unproven read, or anything else, prefixed. */
function blockedUnless(e: unknown, what: string): AdoptionBlocked {
    if (e instanceof AdoptionBlocked) return e;
    if (e instanceof Inconclusive) return new AdoptionBlocked(e.message);
    return new AdoptionBlocked(`${what}: ${(e as Error).message}`);
}

const LISTING = 'the earlier runners could not be read';

/** The candidates, tried again on a refusal after a pause a stand-down cuts short. */
async function listed<F extends EarlierRun>(
    p: AdoptPrimitives<F>,
    job: BoardJob,
    signal: AbortSignal | undefined
): Promise<F[]> {
    const { attempts = 1, retryMs = 0, sleep } = p.pacing ?? {};
    let failure: unknown;
    const attempt = async (deadline: number): Promise<F[] | undefined> => {
        try {
            return await p.list(job, { deadline, signal });
        } catch (e) {
            failure = e;
        }
    };
    const found = sleep
        ? await pollFor(
              {
                  ms: attempts * retryMs,
                  everyMs: retryMs,
                  sleep,
                  ...(signal && { signal }),
                  abandoned: adoptionAbandoned,
              },
              attempt
          )
        : await attempt(Infinity);
    if (found) return found;
    throw blockedUnless(failure, LISTING);
}

/** The newest earlier run of a claim before `job`'s, of the same command, that the executor admits. */
async function newestEarlier<F extends EarlierRun>(
    p: AdoptPrimitives<F>,
    job: BoardJob,
    signal: AbortSignal | undefined
): Promise<F | null> {
    try {
        const candidates = (await listed(p, job, signal))
            .filter((f) => f.claimSeq < job.claimSeq && f.commandMark === commandMark(job.command))
            .sort((a, b) => b.claimSeq - a.claimSeq);
        for (const candidate of candidates) {
            const found = p.admit ? await p.admit(candidate, job, signal) : candidate;
            if (found) return found;
        }
        return null;
    } catch (e) {
        if (signal?.aborted || e instanceof AdoptionBlocked) throw e;
        throw blockedUnless(e, LISTING);
    }
}

/**
 * The one adoption: the newest earlier run is waited out and read exactly as the attached run reads
 * its own, then kept (`adopted`) and everything older swept — never an unread run. Null when there is
 * no run to adopt or the earlier run was taken away (the claim goes back, the re-claim fence takes it).
 * `signal` is the attempt's stand-down: an abandoned adoption deletes nothing.
 */
export async function adoptEarlierRun<F extends EarlierRun>(
    p: AdoptPrimitives<F>,
    adopted: Map<string, string>,
    job: BoardJob,
    signal?: AbortSignal
): Promise<AdoptedRun | LiveRun | null> {
    const first = await newestEarlier(p, job, signal);
    if (!first) return null;
    let rolledBack = false;
    try {
        // A takeover of a stale claim deletes it: never once the attempt stood down.
        if (signal?.aborted) throw adoptionAbandoned();
        await p.begin(job, signal);
        if (first.live)
            return await takeOver(p, adopted, first as F & { live: { startedAt: string } }, { job, signal });
        const found = await p.awaitEnd(first, job, signal);
        if (!found) {
            rolledBack = true;
            return await giveBack(p, job);
        }
        const { end, body } = await p.read(found, job, signal);
        const { timedOut, infraLoss, fields } = settleEnd(end);
        if (infraLoss) {
            rolledBack = true;
            return await giveBack(p, job);
        }
        const { startedAt, ...read } = await body();
        const outcome: RunOutcome = { ...read, timedOut, started: true, ...fields };
        await p.closeReadout(outcome, found, job, { startedAt, signal });
        if (found.session && !outcome.sessionId) outcome.sessionId = found.session;
        // Nothing is deleted once the attempt stood down, whatever the run it read.
        if (signal?.aborted) throw adoptionAbandoned();
        await p.confirmOwnership(found, job, signal);
        adopted.set(job.leaseToken, p.recordKey(found));
        await p.sweep(found, job, signal);
        return { outcome, claimSeq: found.claimSeq };
    } catch (e) {
        adopted.delete(job.leaseToken);
        // A rollback that fails must not replace the error being classified, nor run twice. A live
        // group still writes the tree: its claim stays this attempt's for the next claim to order against.
        if (!rolledBack && !first.live) await p.rollback(job).catch(() => undefined);
        if (signal?.aborted || e instanceof AdoptionBlocked) throw e;
        throw blockedUnless(e, 'the earlier run could not be adopted');
    }
}

/**
 * A released group still running (#829): nothing of it is read or waited for. The claim is confirmed,
 * everything older swept (the group is spared as an adopted run is), and only then is it recorded as
 * this driver's to step into. The caller rebinds its supervisor.
 */
async function takeOver<F extends EarlierRun>(
    p: AdoptPrimitives<F>,
    adopted: Map<string, string>,
    found: F & { live: { startedAt: string } },
    { job, signal }: { job: BoardJob; signal: AbortSignal | undefined }
): Promise<LiveRun> {
    await p.confirmOwnership(found, job, signal);
    adopted.set(job.leaseToken, p.recordKey(found));
    // Recorded before the sweep, which spares the live group by it; forgotten when the sweep fails.
    const forget = p.adoptLive(found);
    try {
        await p.sweep(found, job, signal);
        // Nothing is deleted once the attempt stood down, whatever the run it took.
        if (signal?.aborted) throw adoptionAbandoned();
    } catch (e) {
        forget();
        throw e;
    }
    return {
        live: true,
        prior: found.prior,
        claimSeq: found.claimSeq,
        session: found.session,
        startedAt: found.live.startedAt,
        forget,
    };
}

async function giveBack<F extends EarlierRun>(p: AdoptPrimitives<F>, job: BoardJob): Promise<null> {
    await p.rollback(job);
    return null;
}
