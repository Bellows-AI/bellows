import type { Board, BoardJob } from './board.js';
import type { CheckpointPointer, CheckpointRead } from './board-checkpoint.js';
import { claimContinuesSession, opencodeDbPath, runWorkingDir, transcriptDir } from './claim.js';
import { checkpointRestoreScript } from './container-scripts.js';
import { CLAUDE_CODE, OPENCODE } from './executors.js';
import { parseLastJsonLine } from './json-parse.js';
import { checkoutDir, CREDENTIAL_HELPER, remoteUrl, type SyncResult, worktreeBranch } from './publish.js';
import { claimStepEnv, detailOf, type StepHost, stepRequest, submitStep } from './supervised-steps.js';
import { FIRST_GENERATION } from './task-volume.js';

/**
 * Restoring a thread's task tree onto a replacement volume (issue #775). A volume is found by the
 * thread's root label; its generation is the highest one listed. A thread whose volume is gone is
 * rebuilt from the board's checkpoint into the NEXT generation by `scripts/checkpoint-restore.cjs`,
 * run as a supervised step in the attempt's group; the older generation is deleted only after that
 * step reports ok, so a failed restore leaves the new volume for the next claim to adopt and the old
 * one intact.
 */

/** The restore still owed to the volume this attempt runs on. */
export interface TaskRestore {
    /** Null when no complete checkpoint is stored: the step then only verifies the tree is on the volume. */
    checkpoint: CheckpointPointer | null;
    /** The older generations to delete once the restore reports ok. */
    older: number[];
    restored: boolean;
}

/** The thread's volumes as the executor listed them: a CONFIRMED listing, never a guess. */
export interface VolumeListing {
    /** The generations that can be mounted, any order. */
    live: number[];
    /** The highest generation listed at all, a volume being deleted included: its name is not free. */
    highest: number;
    /** Volumes no pod could be scheduled onto (kubernetes): never adopted, deleted once a restore has landed. */
    unschedulable: number[];
}

/** The thread cannot be rebuilt: the failure kind `checkpoint_unrestorable`, a person's to act on. */
export class CheckpointUnrestorable extends Error {}

/** The failure for a thread with no complete checkpoint to restore from. */
function unrestorable(read: CheckpointRead): CheckpointUnrestorable {
    if (read.state === 'none') {
        return new CheckpointUnrestorable('the thread has no task volume and no checkpoint to restore it from');
    }
    if (read.state === 'gone') {
        return new CheckpointUnrestorable("the thread's checkpoint is no longer stored on the board");
    }
    return new CheckpointUnrestorable("the thread's checkpoint was cut at its size cap and carries no tree");
}

/**
 * The restore an adopted restored generation (`live[0]`) still owes. A volume made by an earlier restore may not
 * have been filled, and the plan cannot tell: the restore step does (the checkout is there, or it is not), so a
 * continuing claim asks again and always schedules it. With no complete checkpoint it carries none and only
 * verifies the tree. A volume no pod could be scheduled onto holds the tree the live one may lack: the claim runs
 * on it, its mark kept until a later claim finds no live volume, so an interruption before the step has found
 * the tree there plans this same choice again. The live volumes go only once it has.
 */
async function owedRestore(
    source: Pick<Board, 'checkpoint'>,
    job: BoardJob,
    live: number[],
    unschedulable: number[]
): Promise<void> {
    const [, ...older] = live;
    const read = await source.checkpoint(job);
    if (read.state === 'found' && !read.checkpoint.truncated) {
        job.taskRestore = { checkpoint: read.checkpoint, older: [...older, ...unschedulable], restored: false };
        return;
    }
    const [held] = [...unschedulable].sort((x, y) => y - x);
    if (held !== undefined) job.taskGeneration = held;
    job.taskRestore = { checkpoint: null, older: held === undefined ? older : live, restored: false };
}

/**
 * Decides which volume the attempt runs on and what it owes it, setting `job.taskGeneration` and
 * `job.taskRestore`. Answers whether the volume must be created.
 *
 * A thread "ran before" exactly when its claim continues a session (`claimContinuesSession`: a
 * follow-up, or a takeover that resumes its own attempt's session): that claim is owed the tree the
 * session left. Any other claim starts the task and syncs fresh, so a retry from the pushed branch
 * stays available when the volume is gone. A continuing claim with no volume needs a complete
 * checkpoint, and `none`, `gone` and `truncated` all fail `checkpoint_unrestorable`.
 */
export async function planTaskVolume(
    source: Pick<Board, 'checkpoint'> | undefined,
    job: BoardJob,
    listing: VolumeListing
): Promise<{ create: boolean; unlabel?: number }> {
    const live = [...listing.live].sort((a, b) => b - a);
    const current = live[0];
    if (current !== undefined) {
        job.taskGeneration = current;
        if (current > FIRST_GENERATION && claimContinuesSession(job) && source && !job.taskRestore?.restored) {
            await owedRestore(source, job, live, listing.unschedulable);
        }
        return { create: false };
    }
    if (!claimContinuesSession(job)) {
        job.taskGeneration = listing.highest > 0 ? listing.highest + 1 : FIRST_GENERATION;
        return { create: true };
    }
    if (!source) throw new Error(`job ${job.id}: no checkpoint source to restore the thread's task volume from`);
    const read = await source.checkpoint(job);
    if (read.state !== 'found' || read.checkpoint.truncated) {
        // A volume no pod could be scheduled onto still holds the tree: label cleared, it is adopted again.
        const [held] = [...listing.unschedulable].sort((x, y) => y - x);
        if (held !== undefined) {
            job.taskGeneration = held;
            return { create: false, unlabel: held };
        }
        throw unrestorable(read);
    }
    job.taskGeneration = Math.max(FIRST_GENERATION + 1, listing.highest + 1);
    job.taskRestore = { checkpoint: read.checkpoint, older: [...listing.unschedulable], restored: false };
    return { create: true };
}

/** The CLI keeps a working directory's sessions under `projects/<the path with every non-alphanumeric as '-'>`. */
const projectSegment = (workingDir: string): string => workingDir.replace(/[^A-Za-z0-9]/g, '-');

/** Where the restored sessions go: the claude run's, or the OpenCode run's, never both. */
function sessionEnv(job: BoardJob): Record<string, string> {
    if (job.executorType === OPENCODE) return { OPENCODE_DB: opencodeDbPath(job) };
    if (job.executorType === CLAUDE_CODE) {
        return { SESSIONS_DIR: `${transcriptDir(job)}/projects/${projectSegment(runWorkingDir(job))}` };
    }
    return {};
}

/** The restore step's own bound: it downloads the stream, clones and checks out the whole tree. */
export const RESTORE_DEADLINE_MS = 900_000;

/** The sync result a thrown `CheckpointUnrestorable` ends the attempt with. */
export const unrestorableResult = (e: CheckpointUnrestorable): SyncResult => ({
    ok: false,
    reason: e.message,
    kind: 'checkpoint_unrestorable',
});

/**
 * Runs the owed restore as a supervised step, then deletes the older generations through `removeOlder`.
 * Null when nothing is owed. A restore that fails leaves everything where it was.
 */
export async function restoreTaskTree(
    host: StepHost,
    job: BoardJob,
    options: { githubToken?: string | undefined; removeOlder: (generations: number[]) => Promise<void> }
): Promise<SyncResult | null> {
    const pending = job.taskRestore;
    const checkout = checkoutDir(job);
    const remote = remoteUrl(host.config, job);
    if (!pending || pending.restored || !checkout || !remote) return null;
    const result = await submitStep(
        host,
        job,
        stepRequest(job, 'sync', {
            id: 'restore',
            argv: ['node', '-e', checkpointRestoreScript],
            env: {
                ...claimStepEnv(job, options.githubToken),
                CHECKOUT: checkout,
                REMOTE: remote,
                BRANCH: worktreeBranch(job),
                CHUNKS: JSON.stringify(pending.checkpoint?.chunks ?? []),
                ...sessionEnv(job),
                // The supervisor lays its control endpoint and token over this one step only.
                RESTORE_FEED: '1',
                ...(options.githubToken ? { CRED_HELPER: CREDENTIAL_HELPER } : {}),
            },
            timeoutMs: RESTORE_DEADLINE_MS,
        })
    );
    const failed = (): SyncResult => ({
        ok: false,
        reason: `the checkpoint restore failed: ${detailOf(result, RESTORE_DEADLINE_MS)}`,
    });
    const verdict = result.timedOut ? failed() : parseLastJsonLine<SyncResult>(result.stdout, failed);
    if (!verdict.ok) return verdict;
    pending.restored = true;
    // Durable before destructive: only now may the volume it replaces go. A delete that fails leaves an
    // older generation the next claim sees beside the current one and removes then.
    await options.removeOlder(pending.older).catch(() => undefined);
    return { ok: true, reason: null };
}
