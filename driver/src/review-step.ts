import type { BoardJob, ReviewClaim } from './board.js';
import {
    CONTROL_TOKEN_ENV,
    CONTROL_URL_ENV,
    REVIEWER_HOME,
    reviewerDataName,
    reviewerTranscriptName,
    reviewerTreeDir,
    runnerClaimEnv,
} from './claim.js';
import { claudeExportScript, opencodeReadoutScript } from './container-scripts.js';
import { CLAUDE_CODE } from './executors.js';
import { parseLastJsonLine } from './json-parse.js';
import {
    gitWorktreeScript,
    repoPath,
    reviewWorktreeDir,
    SYNC_DEADLINE_MS,
    type SyncResult,
    worktreeBranch,
} from './publish.js';
import { reviewerPlan } from './runner-plan.js';
import { OPENCODE_EXPORT_LIMIT, type RunSession } from './runner.js';
import {
    controlTokenOf,
    detailOf,
    type ReviewControl,
    type ReviewExporter,
    type StepHost,
    stepRequest,
    submitStep,
} from './supervised-steps.js';
import { EXPORT_FLUSH_BYTES, EXPORT_FLUSH_MS, EXPORT_SPOOL_MAX_BYTES } from './transcript-export.js';
import { type StepResult, SUPERVISOR_ENV } from './supervisor-contract.js';

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
export function reviewRestoreEnv(
    host: Pick<StepHost, 'config'>,
    caller: BoardJob,
    review: ReviewClaim
): Record<string, string> | null {
    const clone = repoPath(host.config, review);
    const worktree = reviewWorktreeDir(host.config, caller, review);
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
 * by another uid, and the reviewer's gitconfig is not writable). Never a GitHub token.
 */
export function reviewStepEnv(
    host: Pick<StepHost, 'config'>,
    caller: BoardJob,
    review: ReviewClaim,
    session: RunSession | null
): { argv: string[]; env: Record<string, string> } | null {
    const clone = repoPath(host.config, review);
    const worktree = reviewWorktreeDir(host.config, caller, review);
    if (!clone || !worktree) return null;
    const plan = reviewerPlan(host.config, review, session);
    return {
        argv: plan.argv,
        env: {
            ...Object.fromEntries(plan.env),
            ...runnerClaimEnv(review),
            // The review row's OWN board identity (never the caller's): the branch reporter and the
            // usage attribution key on it, as for any run.
            FACTORY_STATS_URL: host.config.statsUrl,
            RUNNER_JOB_ID: review.id,
            RUNNER_LEASE_TOKEN: review.leaseToken,
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

/** One review to run: the caller whose group hosts it, the review's own claim, the session it runs and its export. */
export interface ReviewRun {
    caller: BoardJob;
    review: ReviewClaim;
    session: RunSession | null;
    exporter?: ReviewExporter;
    /** The run of this lease (1 for the first); a later one names its own step, the ledger having answered the first. */
    round?: number;
    /** False for a round whose lost answer the driver runs again: its export waits for the round that stays. */
    final?: boolean;
}

/** A review run from the runner's arguments: what the runner interface hands each executor's transport. */
export const reviewRunOf = (
    caller: BoardJob,
    review: ReviewClaim,
    session: RunSession | null,
    control?: ReviewControl
): ReviewRun => ({
    caller,
    review,
    session,
    ...(control?.exporter ? { exporter: control.exporter } : {}),
    ...(control?.round ? { round: control.round } : {}),
    ...(control?.final === false ? { final: false } : {}),
});

const EXPORT_STEP_TIMEOUT_MS = 180_000;
const EXIT_TIMEOUT = 124;
const EXIT_CANCELLED = 130;
/** The opencode readout's export, per stream: the step's stdout is capped at 1 MiB, tail kept. */
const READOUT_SHARES = 4;
const REVIEW_READOUT_LIMIT = OPENCODE_EXPORT_LIMIT / READOUT_SHARES;

/** How the manifest closes: `complete` for a review that ran to its end, else `partial` with the cause. */
function exportClosing(result: StepResult): { state: 'complete' | 'partial'; cause: string | null } {
    if (result.exitCode === 0 && !result.timedOut) return { state: 'complete', cause: null };
    if (result.timedOut || result.exitCode === EXIT_TIMEOUT) return { state: 'partial', cause: 'review_timeout' };
    return { state: 'partial', cause: result.exitCode === EXIT_CANCELLED ? 'review_cancelled' : 'review_failed' };
}

/**
 * The review's close-time export (amendment B5): one more supervised step of the caller's group,
 * run once the review has ended however it ended. A claude-code review runs the transcript exporter
 * in its one-shot mode over the reviewer's own store, under the review row's exporter token; an
 * opencode review runs the session readout over the reviewer's own database and hands its stdout to
 * the exporter. Nothing here can change the review's verdict, and a failed export leaves the bytes
 * on the volume.
 */
async function exportReview(host: StepHost, toRun: ReviewRun, result: StepResult, startedAt: Date): Promise<void> {
    const { caller, review, session, exporter } = toRun;
    if (!exporter) return;
    const step =
        review.executorType === CLAUDE_CODE
            ? claudeExportRequest(toRun, result, startedAt)
            : {
                  argv: ['node', '-e', opencodeReadoutScript],
                  env: {
                      OPENCODE_DB: `${REVIEWER_HOME}/${reviewerDataName(review)}/opencode/opencode.db`,
                      OPENCODE_DIR: reviewWorktreeDir(host.config, caller, review) ?? '',
                      RUN_STARTED_MS: String(startedAt.getTime()),
                      EXPORT_LIMIT_BYTES: String(REVIEW_READOUT_LIMIT),
                  },
              };
    if (step === null || (review.executorType === CLAUDE_CODE && session === null)) return;
    try {
        const answered = await submitStep(
            host,
            caller,
            stepRequest(review, 'review', {
                id: 'review-export',
                ...step,
                cwd: REVIEWER_HOME,
                timeoutMs: EXPORT_STEP_TIMEOUT_MS,
            })
        );
        if (review.executorType !== CLAUDE_CODE && answered.exitCode === 0) await exporter.readout(answered.stdout);
    } catch {
        // An export is never a verdict: a lost step or a refused readout leaves the files where they are.
    }
}

function claudeExportRequest(
    { caller, review, exporter }: ReviewRun,
    result: StepResult,
    startedAt: Date
): { argv: string[]; env: Record<string, string> } | null {
    const controlUrl = caller.supervisorEnv?.[SUPERVISOR_ENV.controlUrl];
    if (!controlUrl || !exporter) return null;
    const { state, cause } = exportClosing(result);
    return {
        argv: ['node', '-e', claudeExportScript],
        env: {
            CLAUDE_TRANSCRIPT_DIR: `${REVIEWER_HOME}/${reviewerTranscriptName(review)}`,
            RUN_STARTED_AT: startedAt.toISOString(),
            EXPORT_FLUSH_BYTES: String(EXPORT_FLUSH_BYTES),
            EXPORT_FLUSH_MS: String(EXPORT_FLUSH_MS),
            EXPORT_SPOOL_MAX_BYTES: String(EXPORT_SPOOL_MAX_BYTES),
            EXPORT_ONCE: state,
            ...(cause ? { EXPORT_ONCE_CAUSE: cause } : {}),
            [CONTROL_URL_ENV]: controlUrl,
            [CONTROL_TOKEN_ENV]: exporter.token,
        },
    };
}

/**
 * Runs one review in the caller's group and answers the review step's result: the home made, the
 * worktree restored, the executor run to its end. A step that could not be set up answers a
 * failed result with the reason; a lost supervisor rejects (`stepLost`), and an abort of `signal`
 * cancels the review through the step channel. The restore and the home are quick and not cancelled.
 */
export async function runReviewSteps(host: StepHost, toRun: ReviewRun, signal?: AbortSignal): Promise<StepResult> {
    const { caller, review, session, round = 1 } = toRun;
    if (signal?.aborted) throw new Error('the review was cancelled before it was submitted');
    const startedAt = new Date();
    const restoreEnv = reviewRestoreEnv(host, caller, review);
    const run = reviewStepEnv(host, caller, review, session);
    const worktree = reviewWorktreeDir(host.config, caller, review);
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
        id: round > 1 ? `run-${round}` : 'run',
        argv: run.argv,
        cwd: worktree,
        env: run.env,
        timeoutMs: reviewBudgetMs(host.config, review),
    });
    const token = controlTokenOf(caller);
    const cancel = (): void => host.sink.cancel(token, step.id);
    signal?.addEventListener('abort', cancel, { once: true });
    let result: StepResult;
    try {
        result = await submitStep(host, caller, step, signal);
    } finally {
        signal?.removeEventListener('abort', cancel);
    }
    // A lost answer the driver runs again is not the end of the review: its export is the last round's.
    if (toRun.final !== false || result.exitCode !== null) await exportReview(host, toRun, result, startedAt);
    return result;
}
