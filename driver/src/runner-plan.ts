import type { BoardJob } from './board.js';
import type { DriverConfig } from './config.js';
import {
    npmQuietEnv,
    opencodeDataDir,
    RESUME_MAY_BE_UNWRITTEN_ENV,
    REVIEWER_HOME,
    reviewerDataName,
    reviewerTranscriptName,
    repoCacheEnv,
    SESSION_ID,
    transcriptDir,
} from './claim.js';
import { agentPrompt } from './continuation.js';
import { OPENCODE } from './executors.js';
import {
    claudeSystemPromptArgs,
    claudeTurnContextEnv,
    opencodeAgentArgs,
    opencodeTurnPrompt,
} from './master-prompt.js';
import { baseBranchOf, worktreeDir } from './publish.js';
import { randomUUID } from 'node:crypto';
import type { RunSession } from './runner.js';

/**
 * The one decision about WHAT a runner is asked to do, for both executors and both platforms.
 *
 * docker and kubernetes used to compose this twice — `pushClaudeCodeArgs`/`pushOpencodeArgs` over
 * there, `claudeRunnerPlan`/`opencodeRunnerPlan` here — with each copy's comment claiming to be
 * the other's "identical twin". They were not: the k8s copy suppressed the claude prompt on a
 * resume that was not a follow-up, and the two refused an opencode session on different
 * predicates. AGENTS.md makes kubernetes the primary executor, so a parity gap of that shape is a
 * live bug, not a style problem. It exists once now, and the transports only RENDER it: docker as
 * `-e NAME=value` + argv after the image name, kubernetes as `EnvVar[]` + the container's `args`.
 * The ENTRYPOINT of either executor image receives exactly `cliArgs`, so the platform below the
 * container is the only remaining difference.
 */
export interface RunnerPlan {
    /** Executor-specific environment, in order. Paths, ids and the board's turn context — never a credential. */
    envPairs: [string, string][];
    /** What the executor image's ENTRYPOINT is handed, in order. */
    cliArgs: string[];
}

/**
 * The run's checkout, asserted: a repo job runs in its task worktree (issue #35) — one per task
 * thread, branched off the remote default — and a command-only job at the member root, where it
 * always started. A repo label this driver cannot resolve a worktree for is refused before any
 * container or pod spec exists, on both platforms, from this one line.
 */
export function assertWorktreeResolvable(config: DriverConfig, job: BoardJob): void {
    if (job.repo && !worktreeDir(config, job)) {
        throw new Error(
            `refusing to run job ${job.id}: the board reported a repo label this driver cannot resolve a task worktree for (${job.repo})`
        );
    }
}

/**
 * A session id that is about to become argv or a pod spec value. Safe by construction when this
 * process minted it; the assertion is for the ones that arrive on a claim.
 */
function assertSessionId(job: BoardJob, session: RunSession): void {
    if (!SESSION_ID.test(session.id)) {
        throw new Error(`refusing to run job ${job.id}: a session id that is not a safe token: ${session.id}`);
    }
}

/**
 * The branch a batch task bases on, for the agent's side of the run: the claude git guard's merge
 * hint and the opencode entrypoint's merge allow name it instead of origin/HEAD.
 */
const baseBranchEnv = (job: BoardJob): [string, string][] => {
    const base = baseBranchOf(job);
    return base ? [['BASE_BRANCH', base]] : [];
};

/**
 * Issue #822: a takeover or handover of a session the row minted itself (`ownSession` — a root's,
 * a sessionless follow-up's) may have nothing behind it, its driver lost before the CLI's first
 * write — the runner may start that one anew (the claude bridge's `startUnwrittenResume`, the
 * opencode entrypoint). A session inherited from an earlier row, a follow-up's parent's, was
 * written by that row, and its missing transcript stays the CLI's refusal.
 */
const unwrittenResumeEnv = (job: BoardJob, session: RunSession): [string, string][] =>
    session.resume && job.ownSession ? [[RESUME_MAY_BE_UNWRITTEN_ENV, '1']] : [];

/**
 * opencode: headless only, and opencode mints its own session ids — a fresh run is `run <command>`
 * with no session at all, and a follow-up is `run --session <id> <command>` with the session
 * opencode ITSELF created on the earlier run, persisted via XDG_DATA_HOME. It cannot ADOPT an id
 * minted in advance, which is exactly what `resume: false` beside a session means, so that is the
 * refusal — the loop refuses the state first, and this is the runner asserting it too.
 *
 * The session database has to outlive the container or there is nothing to resume into: a fresh
 * one starts empty. XDG_DATA_HOME points at the task's own directory on the workspaces volume,
 * persisting it per task (thread root) inside the member's tree — a dot-directory the workspace
 * reconcile never mistakes for a checkout.
 */
function opencodePlan(config: DriverConfig, job: BoardJob, session: RunSession | null): RunnerPlan {
    if (session && !session.resume) {
        throw new Error(`refusing to run job ${job.id}: the opencode runner cannot adopt a minted session`);
    }
    const envPairs: [string, string][] = [
        ['XDG_DATA_HOME', opencodeDataDir(config, job)],
        ...npmQuietEnv(job),
        ...repoCacheEnv(config, job),
        ...baseBranchEnv(job),
    ];
    const cliArgs = ['run', ...opencodeAgentArgs()];
    if (session) {
        assertSessionId(job, session);
        cliArgs.push('--session', session.id);
        // Only a resumed run has a session here, and the reporter must name it — its tokens
        // belong to the SAME conversation the parent ran. A fresh run is discovered live by the
        // reporter from the session database XDG_DATA_HOME keeps.
        envPairs.push(['BELLOWS_SESSION_ID', session.id], ...unwrittenResumeEnv(job, session));
    }
    cliArgs.push(opencodeTurnPrompt(job));
    return { envPairs, cliArgs };
}

/**
 * claude-code: every job runs as a session. `--resume` keeps the original id — forking it is a
 * separate flag — which is what keeps a follow-up in its parent's conversation, and `--session-id`
 * starts one on an id this process minted.
 *
 * The command is the prompt, and it is delivered UNCONDITIONALLY, resume or not. That is docker's
 * rule and now both platforms': a claim that arrives with a command is a claim asking for that
 * command to run, and a restored conversation that receives nothing idles to the deadline. It goes
 * LAST, so a command that looks like a flag is still read as a prompt.
 *
 * FACTORY_TRANSCRIPT_DIR is the transcript store — fresh runs and resumes alike, because the
 * resume is the run that needs the thread's earlier transcripts sitting in its config dir. The
 * entrypoint redirects CLAUDE_CONFIG_DIR onto it (headless only), so transcript persistence does
 * not depend on which executor ran the job. A path literal like WORKDIR, never a credential.
 */
function claudePlan(config: DriverConfig, job: BoardJob, session: RunSession | null): RunnerPlan {
    if (!session) {
        throw new Error(`refusing to run job ${job.id}: the claude-code runner runs every job as a session`);
    }
    // No `assertSessionId` here, deliberately: a claude session id is safe by construction —
    // minted by this driver as a uuid, or arriving on the claim only after the board's own token
    // check. The opencode path asserts because the id it carries was minted by the CLI itself.
    const envPairs: [string, string][] = [
        ['FACTORY_TRANSCRIPT_DIR', transcriptDir(config, job)],
        ['BELLOWS_SESSION_ID', session.id],
        ...unwrittenResumeEnv(job, session),
        ...claudeTurnContextEnv(job),
        ...npmQuietEnv(job),
        ...repoCacheEnv(config, job),
        ...baseBranchEnv(job),
    ];
    const cliArgs = [session.resume ? '--resume' : '--session-id', session.id];
    if (config.skipPermissions) cliArgs.push('--dangerously-skip-permissions');
    // The board-owned Factory execution context (issue #244), through Claude Code's own
    // system-instruction channel — additive to its built-in system prompt, never a replacement.
    // It is the same text on every claim of a thread; the per-node turn context rides the env above.
    cliArgs.push(...claudeSystemPromptArgs(job));
    // Framed as a continuation when the claim continues an interrupted attempt (issue #822).
    cliArgs.push('-p', agentPrompt(job));
    return { envPairs, cliArgs };
}

/** The plan for whichever executor the task's profile selected. */
export function runnerPlan(config: DriverConfig, job: BoardJob, session: RunSession | null): RunnerPlan {
    return job.executorType === OPENCODE ? opencodePlan(config, job, session) : claudePlan(config, job, session);
}

/** The executor image's ENTRYPOINT as argv, which a reviewer container runs as a command (issue #774). */
const entrypointArgv = (job: BoardJob): string[] => [
    '/usr/local/bin/factory-launch',
    job.executorType === OPENCODE ? '/usr/local/bin/opencode-executor' : '/usr/local/bin/claude-executor',
];

/**
 * What the reviewer container runs for one review (issue #774): the executor entrypoint's argv, and
 * the plan's env with the two places a run keeps session state moved into the reviewer's own home
 * (`REVIEWER_HOME`, mounted from the task volume read-write) — the transcript store and opencode's
 * database would otherwise sit in the member tree, which the reviewer mounts read-only.
 */
export function reviewerPlan(
    config: DriverConfig,
    review: BoardJob,
    session: RunSession | null
): { argv: string[]; env: [string, string][] } {
    const plan = runnerPlan(config, review, session);
    const home: Record<string, string> = {
        FACTORY_TRANSCRIPT_DIR: `${REVIEWER_HOME}/${reviewerTranscriptName(review)}`,
        XDG_DATA_HOME: `${REVIEWER_HOME}/${reviewerDataName(review)}`,
    };
    return {
        argv: [...entrypointArgv(review), ...plan.cliArgs],
        env: plan.envPairs.map(([name, value]) => [name, home[name] ?? value]),
    };
}

/** The session a claim's run uses: the one it resumes, or a fresh one the driver mints (claude-code only). */
export function pickSession(job: BoardJob, executorType: BoardJob['executorType']): RunSession | null {
    // opencode mints its own session ids (`ses_…`) and cannot adopt one, so a fresh run gets
    // none — the runner scrapes the id the run used and reports it when the outcome lands. A
    // follow-up claim carries the session opencode itself created, restored via `--session` on
    // the runner.
    if (executorType === OPENCODE) return job.resumeSessionId ? { id: job.resumeSessionId, resume: true } : null;
    return job.resumeSessionId ? { id: job.resumeSessionId, resume: true } : { id: randomUUID(), resume: false };
}
