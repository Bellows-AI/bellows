import {
    OBJECTIVE_MODE,
    emptyBlock,
    type RunUsage,
    type TaskUsage,
    type Tokens,
    type UsageBlock,
} from '@factory-ai/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { Job, JobQuestion } from '../src/api/useJobs.js';
import type {
    GateActivity,
    GateOutcomeCounts,
    JobActivity,
    PrActivity,
    ThreadActivity,
} from '../src/api/useJobActivity.js';
import { type ComposerDraftInput, type ComposerDraftStore, EMPTY_FILES } from '../src/composer-draft.js';
import { TaskComposer } from '../src/panels/TaskComposer.js';
import { TaskDetail } from '../src/panels/TaskDetail.js';
import { TaskHeader } from '../src/panels/TaskHeader.js';
import type { RepoOption, WorkflowParamChoice } from '../src/task-composer.js';
import type { FollowUpViewer } from '../src/task-outcome.js';

/**
 * The same contract the other panel suites pin: props in, markup out, and no DOM — `useEffect`
 * never runs under renderToStaticMarkup, so the hooks are exercised by the pages that own them and
 * this suite exercises what the reader actually sees.
 */
/** A draft store that holds nothing and writes nowhere: what a panel renders against offline. */
export const inertDraftStore = (overrides: Partial<ComposerDraftStore> = {}): ComposerDraftStore => ({
    state: null,
    save: () => {},
    clear: () => {},
    files: EMPTY_FILES,
    updateTaskFiles: () => {},
    clearTaskFiles: () => {},
    followUps: {},
    saveFollowUp: () => {},
    updateFollowUp: () => {},
    clearFollowUp: () => {},
    submits: {},
    beginSubmit: () => {},
    finishSubmit: () => {},
    taskCompletions: 0,
    ...overrides,
});

export function job(overrides: Partial<Job> = {}): Job {
    return {
        id: '11111111-1111-4111-8111-111111111111',
        command: 'fix the flaky login test',
        status: 'succeeded',
        attempts: 1,
        author: null,
        stoppedBy: null,
        doneBy: null,
        exitCode: 0,
        output: null,
        repo: null,
        executor: null,
        workflowName: null,
        workflowNode: null,
        mode: OBJECTIVE_MODE,
        followUpTo: null,
        rootJobId: '11111111-1111-4111-8111-111111111111',
        doneAt: null,
        cancelRequestedAt: null,
        workspacePath: null,
        createdAt: '2026-09-01T12:00:00.000Z',
        startedAt: '2026-09-01T12:00:01.000Z',
        finishedAt: '2026-09-01T12:04:00.000Z',
        wallClockMs: null,
        agentTurns: null,
        setupMs: null,
        interruptions: [],
        taskWallClockMs: null,
        summary: null,
        failureKind: null,
        // A finished claude-code run has a session by default here: the follow-up composer is
        // offered for exactly these, and the sessionless case has its own test below.
        sessionId: '33333333-3333-4333-8333-333333333333',
        waitReason: null,
        waitingSince: null,
        waitTerminalReason: null,
        questions: [],
        connections: [],
        bindingRevision: 0,
        integrationRequirements: [],
        executionUser: null,
        ...overrides,
    };
}

/** One pending, answerable AskUserQuestion call with a single single-select question. */
export function question(overrides: Partial<JobQuestion> = {}): JobQuestion {
    return {
        id: 'toolu_01',
        attempt: 1,
        questions: [
            {
                question: 'Which database?',
                header: 'Database',
                multiSelect: false,
                options: [{ label: 'Postgres', description: 'The board already runs it' }, { label: 'SQLite' }],
            },
        ],
        status: 'pending',
        answerable: true,
        answers: null,
        answeredBy: null,
        askedAt: '2026-09-01T12:02:00.000Z',
        answeredAt: null,
        ...overrides,
    };
}

export interface ComposerArgs {
    repos?: RepoOption[] | null;
    /** Why `repos` is null, when the repositories read failed or answered with a named error. */
    reposError?: string | null;
    /** The workspace (executors) read has answered; false renders its loading or error screen. */
    workspaceLoaded?: boolean;
    workspaceError?: string | null;
    onRetryRepos?: () => void;
    onRetryWorkspace?: () => void;
    /** The composer's combined options, scope-qualified (issue 391). */
    executors?: { name: string; type: string; scope: 'user' | 'org' }[];
    /** The poll's resolved default; defaults to the first option when any are given. */
    defaultExecutor?: { name: string; scope: 'user' | 'org' } | null;
    /** The workflow choices for the repo context; null hides the select (no workflows served). */
    workflows?:
        | readonly {
              id: string;
              name: string;
              scope: 'org' | 'user' | 'repo';
              params?: WorkflowParamChoice[];
          }[]
        | null;
    actionError?: string | null;
    sending?: boolean;
    /** The draft the store holds for this member — what a return from Settings restores. */
    restored?: ComposerDraftInput | null;
}

export const renderComposer = ({
    repos = [{ owner: 'acme', name: 'web' }],
    reposError = null,
    workspaceLoaded = true,
    workspaceError = null,
    onRetryRepos = () => {},
    onRetryWorkspace = () => {},
    executors = [{ name: 'main', type: 'claude-code', scope: 'user' }],
    defaultExecutor,
    workflows = null,
    actionError = null,
    sending = false,
    restored = null,
}: ComposerArgs = {}) =>
    // The Settings remediation is an SPA Link, so the panel needs a routing context to render.
    renderToStaticMarkup(
        <MemoryRouter>
            <TaskComposer
                repos={repos}
                reposError={reposError}
                onRetryRepos={onRetryRepos}
                workspaceLoaded={workspaceLoaded}
                workspaceError={workspaceError}
                onRetryWorkspace={onRetryWorkspace}
                executors={executors}
                defaultExecutor={defaultExecutor ?? executors[0] ?? null}
                workflows={workflows}
                actionError={actionError}
                sending={sending}
                onSend={async () => null}
                draftStore={inertDraftStore({
                    state: restored === null ? null : { ...restored, owner: 'org-1:user-1' },
                })}
            />
        </MemoryRouter>
    );

export interface DetailArgs {
    /** One task or a whole follow-up chain — the page hands the polled thread over as-is. */
    jobs?: Job[] | null;
    error?: string | null;
    actionError?: string | null;
    followUpError?: string | null;
    sending?: boolean;
    /** Who is looking. The default — no account, and the fixture's null author — is the author. */
    viewer?: FollowUpViewer;
    /** Every run's activity answer by job id, as the page's hook handed it over; absent is "loading". */
    activity?: ThreadActivity;
}

/** The AUTH_MODE-agnostic default: a null viewer on a null-author row may follow up. */
const ANONYMOUS_VIEWER: FollowUpViewer = { loading: false, id: null };

export const renderDetail = ({
    jobs = [job()],
    error = null,
    actionError = null,
    followUpError = null,
    sending = false,
    viewer = ANONYMOUS_VIEWER,
    activity = {},
}: DetailArgs = {}) =>
    renderToStaticMarkup(
        // The sessionless branch carries a router Link (Start a new task), so the panel renders
        // under a router the same way the page mounts it.
        <MemoryRouter>
            <TaskDetail
                jobs={jobs}
                viewer={viewer}
                error={error}
                actionError={actionError}
                followUpError={followUpError}
                sending={sending}
                onFollowUp={async () => null}
                draftStore={inertDraftStore()}
                onAnswer={async () => ({ state: 'failed', error: 'not wired in this suite' })}
                onConnectionChange={() => {}}
                activity={activity}
            />
        </MemoryRouter>
    );

export interface HeaderArgs {
    jobs?: Job[] | null;
    stoppingId?: string | null;
    doneId?: string | null;
    viewer?: FollowUpViewer;
}

export const renderHeader = ({
    jobs = [job()],
    stoppingId = null,
    doneId = null,
    viewer = ANONYMOUS_VIEWER,
}: HeaderArgs = {}) =>
    renderToStaticMarkup(
        <TaskHeader
            jobs={jobs}
            viewer={viewer}
            stoppingId={stoppingId}
            doneId={doneId}
            onStop={async () => {}}
            onDone={async () => {}}
            onRemoveRequest={() => {}}
        />
    );

export const NO_TOKENS: Tokens = { input: null, output: null, cacheRead: null, cacheCreation: null };

/** A measured block of exactly these tokens (a type left out was never measured), or an unmeasured one for null. */
export function usageBlock(tokens: Partial<Tokens> | null, over: Partial<UsageBlock> = {}): UsageBlock {
    if (tokens === null) return { ...emptyBlock('unmeasured'), ...over };
    const t = { ...NO_TOKENS, ...tokens };
    const base = emptyBlock('measured');
    const kinds = (v: number | null) => (v === null ? null : ('exact' as const));
    return {
        ...base,
        tokens: t,
        assigned: t,
        precision: {
            input: kinds(t.input),
            output: kinds(t.output),
            cacheRead: kinds(t.cacheRead),
            cacheCreation: kinds(t.cacheCreation),
        },
        ...over,
    };
}

export function runUsage(
    jobId: string,
    kind: RunUsage['kind'],
    tokens: Partial<Tokens> | null,
    over: Partial<RunUsage> & { block?: Partial<UsageBlock> } = {}
): RunUsage {
    const { block, ...run } = over;
    return {
        jobId,
        kind,
        reviewOf: null,
        live: false,
        operational: kind !== 'review',
        startedAt: '2026-09-01T12:00:01.000Z',
        endedAt: '2026-09-01T12:04:00.000Z',
        usage: usageBlock(tokens, block),
        ...run,
    };
}

/** The canonical task: its usage is the type-wise sum of the runs given (null-aware). */
export function taskUsage(
    taskId: string,
    runs: RunUsage[],
    over: { taskOwned?: UsageBlock | null; block?: Partial<UsageBlock> } = {}
): TaskUsage {
    const sum: Tokens = { ...NO_TOKENS };
    const parts = [...runs.map((run) => run.usage), ...(over.taskOwned ? [over.taskOwned] : [])];
    for (const part of parts) {
        for (const key of Object.keys(sum) as (keyof Tokens)[]) {
            const v = part.tokens[key];
            if (v !== null) sum[key] = (sum[key] ?? 0) + v;
        }
    }
    const measured = parts.some((p) => p.state === 'measured');
    return {
        taskId,
        removed: false,
        usage: usageBlock(measured ? sum : null, {
            counts: { sessions: 0, runs: runs.length, tasks: 1 },
            ...over.block,
        }),
        runs,
        taskOwned: over.taskOwned ?? null,
    };
}

/** One run's activity answer: its own tokens (null: nothing measured) and, optionally, its task. */
export function activityAnswer(
    jobId: string,
    tokens: Partial<Tokens> | null,
    task: TaskUsage | null = null
): JobActivity {
    return {
        jobId,
        sessionId: 'session',
        from: null,
        to: null,
        bucketMs: null,
        buckets: [],
        usage: usageBlock(tokens),
        task,
        gates: NO_GATES,
        prs: NO_PRS,
        taskActivity: { gates: NO_GATES, prs: NO_PRS },
    };
}

const ZERO_OUTCOMES: GateOutcomeCounts = {
    passed: 0,
    failed: 0,
    setup_failed: 0,
    not_started: 0,
    incomplete: 0,
    running: 0,
    unknown: 0,
};

/** Nothing recorded: every figure null, never zero. */
export const NO_GATES: GateActivity = {
    coverage: null,
    executions: null,
    byOutcome: null,
    measuredMs: null,
    measuredCount: 0,
    unmeasuredCount: 0,
    reused: [],
    observed: null,
};
export const NO_PRS: PrActivity = { coverage: null, counts: null, operations: [], distinct: [] };

/** Recorded gate activity: three fully timed executions (two passed, one failed) unless overridden. */
export function gateActivity(over: Partial<GateActivity> = {}): GateActivity {
    return {
        coverage: 'complete',
        executions: 3,
        byOutcome: { ...ZERO_OUTCOMES, passed: 2, failed: 1 },
        measuredMs: 150_000,
        measuredCount: 3,
        unmeasuredCount: 0,
        reused: [],
        observed: { executions: 0, byOutcome: { ...ZERO_OUTCOMES } },
        ...over,
    };
}

/** An answer whose task-level gate and PR activity is the given one. */
export function withActivity(answer: JobActivity, gates: GateActivity, prs: PrActivity): JobActivity {
    return { ...answer, gates, prs, taskActivity: { gates, prs } };
}

export const OUTCOMES = ZERO_OUTCOMES;

/**
 * A measured task with everything the modal can show: an estimated figure, unlocated and unresolved
 * usage, a review run, a run whose job row is gone, a model row and a task-owned amount with a reason.
 */
export function fullTask(jobId: string, reviewId: string, goneId: string): TaskUsage {
    const owned = usageBlock(
        { input: 5 },
        { unassigned: [{ reason: 'no-segment', tokens: { ...NO_TOKENS, input: 5 } }] }
    );
    const rows = [{ model: 'model-a', rawModels: ['model-a'], querySource: null, tokens: { ...NO_TOKENS, input: 10 } }];
    const task = taskUsage(
        jobId,
        [
            runUsage(jobId, 'run', { input: 10, output: 2 }, { block: { rows } }),
            runUsage(reviewId, 'review', { output: 3 }, { reviewOf: jobId }),
            runUsage(goneId, 'run', { input: 1 }, { operational: false }),
        ],
        { taskOwned: owned }
    );
    task.usage = {
        ...task.usage,
        precision: { ...task.usage.precision, input: 'estimated' },
        unlocated: { ...NO_TOKENS, input: 7 },
        unresolvedTemporality: { observations: 2 },
        rows,
    };
    return task;
}
