import type { BoardJob, ReviewClaim } from './board.js';
import { REVIEWER_HOME, reviewerTreeDir, runnerClaimEnv } from './claim.js';
import { parseLastJsonLine } from './json-parse.js';
import {
    gitWorktreeScript,
    repoPath,
    SYNC_DEADLINE_MS,
    type SyncResult,
    worktreeBranch,
    worktreeDir,
} from './publish.js';
import { reviewerPlan } from './runner-plan.js';
import type { RunSession } from './runner.js';
import { controlTokenOf, detailOf, type StepHost, stepRequest, submitStep } from './supervised-steps.js';
import type { StepResult } from './supervisor-contract.js';

/**
 * One named reviewer's run as supervised steps of its CALLER's task group (issue #774): the
 * reviewer's home on the task volume, the restore of its worktree at the snapshot ref the caller
 * froze, and the review itself, which the supervisor hands to the reviewer container. Every step
 * rides the caller's control channel (`controlTokenOf(caller)`) and is named by the review's own
 * lease, so a re-leased review is a new effect and a redelivered call is answered from the ledger.
 *
 * Nothing here carries a credential: the restore has no token and no credential helper (the ref is
 * already in the shared clone), and the review's env is the plan's literals and the grant the board
 * resolved for the profile — the same claim env a reviewer always had, no more.
 */

const MS_PER_MINUTE = 60_000;
const HOME_STEP_TIMEOUT_MS = 60_000;

const failed = (reason: string): StepResult => ({ exitCode: 1, stdout: '', stderr: reason, timedOut: false });

/** The wall-clock budget of one review: its profile's, never past the operator's ceiling. */
export const reviewBudgetMs = (config: { jobTimeoutMs: number }, review: ReviewClaim): number =>
    Math.min(config.jobTimeoutMs, review.reviewRun.timeoutMinutes * MS_PER_MINUTE);

/**
 * The restore step's env: the script's restore switch and the snapshot ref, the clone and the
 * worktree — and nothing that touches a remote.
 */
export function reviewRestoreEnv(host: Pick<StepHost, 'config'>, review: ReviewClaim): Record<string, string> | null {
    const clone = repoPath(host.config, review);
    const worktree = worktreeDir(host.config, review);
    if (!clone || !worktree) return null;
    return {
        REPO: clone,
        WORKTREE: worktree,
        BRANCH: worktreeBranch(review),
        RESTORE: '1',
        REVIEW_REF: review.reviewRun.ref,
    };
}

/**
 * The review step's env: the plan's literals, the grant, and the few names the reviewer container
 * needs to run an executor over a tree it does not own — its home, the worktree, the telemetry
 * endpoint, and a `safe.directory` for the worktree and the clone (git refuses a repository owned
 * by another uid, and the reviewer's gitconfig is not writable). Never a token.
 */
export function reviewStepEnv(
    host: Pick<StepHost, 'config'>,
    review: ReviewClaim,
    session: RunSession | null
): { argv: string[]; env: Record<string, string> } | null {
    const clone = repoPath(host.config, review);
    const worktree = worktreeDir(host.config, review);
    if (!clone || !worktree) return null;
    const plan = reviewerPlan(host.config, review, session);
    return {
        argv: plan.argv,
        env: {
            ...Object.fromEntries(plan.env),
            ...runnerClaimEnv(review),
            WORKDIR: worktree,
            HOME: REVIEWER_HOME,
            OTEL_EXPORTER_OTLP_ENDPOINT: host.config.otelEndpoint,
            GIT_CONFIG_COUNT: '2',
            GIT_CONFIG_KEY_0: 'safe.directory',
            GIT_CONFIG_VALUE_0: worktree,
            GIT_CONFIG_KEY_1: 'safe.directory',
            GIT_CONFIG_VALUE_1: clone,
        },
    };
}

/** One review to run: the caller whose group hosts it, the review's own claim and the session it runs. */
export interface ReviewRun {
    caller: BoardJob;
    review: ReviewClaim;
    session: RunSession | null;
}

/**
 * Runs one review in the caller's group and answers the review step's result: the home made, the
 * worktree restored, the executor run to its end. A step that could not be set up answers a
 * failed result with the reason; a lost supervisor rejects (`stepLost`), and an abort of `signal`
 * cancels the review through the step channel. The restore and the home are quick and not cancelled.
 */
export async function runReviewSteps(host: StepHost, toRun: ReviewRun, signal?: AbortSignal): Promise<StepResult> {
    const { caller, review, session } = toRun;
    if (signal?.aborted) throw new Error('the review was cancelled before it was submitted');
    const restoreEnv = reviewRestoreEnv(host, review);
    const run = reviewStepEnv(host, review, session);
    const worktree = worktreeDir(host.config, review);
    if (!restoreEnv || !run || !worktree) return failed('the review has no repository to restore a worktree of');

    // The reviewer's home on the volume, group-writable so the supervisor's uid can read and remove
    // what the review leaves. A no-op when the directory already exists (the kubelet's mount made it).
    const home = await submitStep(
        host,
        caller,
        stepRequest(review, 'sync', {
            id: 'review-home',
            argv: ['mkdir', '-p', '-m', '2775', reviewerTreeDir(host.config, caller)],
            timeoutMs: HOME_STEP_TIMEOUT_MS,
        }),
        signal
    );
    if (home.exitCode !== 0 || home.timedOut)
        return failed(`the reviewer home was not made: ${detailOf(home, HOME_STEP_TIMEOUT_MS)}`);

    const restored = await submitStep(
        host,
        caller,
        stepRequest(review, 'sync', {
            id: 'review-restore',
            argv: ['node', '-e', gitWorktreeScript],
            env: restoreEnv,
            timeoutMs: SYNC_DEADLINE_MS,
        }),
        signal
    );
    const restore = restored.timedOut
        ? ({ ok: false, reason: detailOf(restored, SYNC_DEADLINE_MS) } as SyncResult)
        : parseLastJsonLine<SyncResult>(restored.stdout, () => ({
              ok: restored.exitCode === 0,
              reason: restored.exitCode === 0 ? null : detailOf(restored, SYNC_DEADLINE_MS),
          }));
    if (!restore.ok) return failed(`the reviewer worktree was not restored: ${restore.reason ?? 'unknown'}`);

    const step = stepRequest(review, 'review', {
        id: 'run',
        argv: run.argv,
        cwd: worktree,
        env: run.env,
        timeoutMs: reviewBudgetMs(host.config, review),
    });
    const token = controlTokenOf(caller);
    const cancel = (): void => host.sink.cancel(token, step.id);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
        return await submitStep(host, caller, step, signal);
    } finally {
        signal?.removeEventListener('abort', cancel);
    }
}
