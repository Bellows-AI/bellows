import { z } from 'zod';
import { judge, success } from '../result.js';
import { defineTool, READ_ONLY } from '../tool.js';
import {
    BOARD_STATUSES,
    BoardRunSchema,
    BoardStatusSchema,
    cut,
    MAX_TEXT_CHARS,
    ownRequirements,
    questionsOpen,
    RunStateSchema,
    stateOfRun,
    type BoardRun,
} from './run-state.js';
import { jobPath } from './runs.js';

const MAX_ID_CHARS = 64;
const TaskIdInput = z.object({
    taskId: z
        .string()
        .min(1)
        .max(MAX_ID_CHARS)
        .describe("A task id (its root run), or the id of any run in the task's thread."),
});

/**
 * The thread read both tools stand on (`GET /api/jobs/:id/thread`, oldest run first). The board resolves any run of
 * the thread, and another organization's id is its own not-found. A status outside the board's vocabulary is kept as
 * text so `get_task_result` can say `inconclusive` instead of failing the whole read.
 */
const LenientRun = BoardRunSchema.extend({ status: z.string() });
const Thread = z.object({ jobs: z.array(LenientRun).min(1) });
type LenientRun = z.infer<typeof LenientRun>;

const known = (status: string): status is (typeof BOARD_STATUSES)[number] =>
    (BOARD_STATUSES as readonly string[]).includes(status);

const requirementsOf = (run: Pick<BoardRun, 'integrationRequirements'>) =>
    (run.integrationRequirements ?? []).map(({ provider, label, reason, source }) => ({
        provider,
        label,
        reason,
        source,
    }));

const RequirementView = z.object({
    provider: z.string(),
    label: z.string(),
    reason: z.enum(['missing', 'ambiguous', 'reconnect']),
    source: z.enum(['create', 'runtime']),
});

const PullRequestView = z.object({
    url: z.string(),
    number: z.number().nullable(),
    headBranch: z.string().nullable(),
    baseBranch: z.string().nullable(),
});
const pullRequestOf = (run: Pick<BoardRun, 'publication'>) =>
    run.publication?.prUrl
        ? {
              url: run.publication.prUrl,
              number: run.publication.prNumber ?? null,
              headBranch: run.publication.headBranch ?? null,
              baseBranch: run.publication.baseBranch ?? null,
          }
        : null;

/** The state of a head run in the shared vocabulary; a status the board does not define is `inconclusive`. */
const stateOf = (run: Pick<LenientRun, 'status' | 'questions' | 'integrationRequirements'>) =>
    known(run.status)
        ? stateOfRun({
              status: run.status,
              questionOpen: questionsOpen(run),
              integrationOpen: requirementsOf(run).length > 0,
          })
        : ('inconclusive' as const);

/** The newest run is the task's present tense; the thread read is never empty (`min(1)`). */
const headOf = (jobs: LenientRun[]): LenientRun => jobs.at(-1) as LenientRun;

export const getTask = defineTool({
    name: 'get_task',
    description:
        "Read one task (a thread of runs) by id, from any run of it: the head run's status and shared `state`, repo, branches, time markers, pull request, open questions and integration requirements, every run in order, and attachment metadata (name, type, size, hash; never content or links). Another organization's id is the board's not-found. For the verdict alone use get_task_result; for logs and gate output use investigate_job and read_job_log.",
    scope: 'factory:read',
    routes: [['GET', '/api/jobs/:id/thread']],
    annotations: READ_ONLY,
    input: TaskIdInput,
    output: z.object({
        taskId: z.string(),
        headRunId: z.string(),
        status: BoardStatusSchema,
        state: RunStateSchema,
        markedDone: z
            .boolean()
            .describe('True once a person declared the task done; a finished run is not marked done.'),
        command: z.string(),
        commandTruncated: z.boolean(),
        repo: z.string().nullable(),
        executor: z.string().nullable(),
        baseBranch: z.string().nullable(),
        mode: z.string().nullable(),
        author: z.string().nullable(),
        createdAt: z.string(),
        startedAt: z.string().nullable(),
        finishedAt: z.string().nullable(),
        waitReason: z.string().nullable(),
        pullRequest: PullRequestView.nullable(),
        openQuestions: z.number(),
        integrationRequirements: z.array(RequirementView),
        runs: z.array(
            z.object({
                id: z.string(),
                followUpTo: z.string().nullable(),
                status: BoardStatusSchema,
                state: RunStateSchema,
                createdAt: z.string(),
                finishedAt: z.string().nullable(),
            })
        ),
        attachments: z.array(
            z.object({
                id: z.string(),
                runId: z.string(),
                name: z.string(),
                mediaType: z.string(),
                size: z.number(),
                sha256: z.string(),
                state: z.string(),
            })
        ),
    }),
    async run({ taskId }, ctx) {
        const judged = judge(
            await ctx.fetch({ method: 'GET', url: `${jobPath(taskId)}/thread` }),
            z.object({ jobs: z.array(BoardRunSchema).min(1) })
        );
        if (!judged.ok) return judged.tagged;
        const { jobs } = judged.data;
        const head = jobs.at(-1) as BoardRun;
        const own = ownRequirements(head, head);
        const command = cut(own.command, MAX_TEXT_CHARS);
        const data = {
            taskId: head.rootJobId,
            headRunId: head.id,
            status: head.status,
            state: stateOf(own),
            markedDone: head.doneAt !== null,
            command: command.text ?? '',
            commandTruncated: command.cut,
            repo: head.repo,
            executor: head.executor,
            baseBranch: head.baseBranch,
            mode: head.mode,
            author: head.author?.login ?? null,
            createdAt: jobs[0]?.createdAt ?? head.createdAt,
            startedAt: head.startedAt,
            finishedAt: head.finishedAt,
            waitReason: head.waitReason,
            pullRequest: pullRequestOf(head),
            openQuestions: (head.questions ?? []).filter((q) => q.status === 'pending' && q.answerable).length,
            integrationRequirements: requirementsOf(own),
            runs: jobs.map((run) => ({
                id: run.id,
                followUpTo: run.followUpTo,
                status: run.status,
                state: stateOf(ownRequirements(run, head)),
                createdAt: run.createdAt,
                finishedAt: run.finishedAt,
            })),
            attachments: jobs.flatMap((run) => (run.attachments ?? []).map((a) => ({ ...a, runId: run.id }))),
        };
        return { outcome: 'ok', result: success(data, `${data.taskId}: ${data.state}, ${jobs.length} runs`) };
    },
});

/** The newest time the board recorded on the head run: its own stamps and the questions asked or answered on it. */
const latestOf = (run: LenientRun): string => {
    const stamps = [
        run.finishedAt,
        run.startedAt,
        run.createdAt,
        ...(run.questions ?? []).flatMap((q) => [q.askedAt, q.answeredAt]),
    ].filter((t): t is string => t !== null && !Number.isNaN(Date.parse(t)));
    return stamps.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a), run.createdAt);
};

const CheckVerdict = z.enum(['passed', 'failed', 'incomplete']);

/** Every gate passed is `passed`; any failed is `failed`; anything still open or unknown is never a pass. */
const verdictOf = (gates: { status: string }[]): z.infer<typeof CheckVerdict> => {
    if (gates.some((g) => g.status === 'failed')) return 'failed';
    return gates.every((g) => g.status === 'passed') ? 'passed' : 'incomplete';
};

export const getTaskResult = defineTool({
    name: 'get_task_result',
    description:
        "The verified outcome of one task, judged on its head run from the board's own records, never from logs: `state` in the shared vocabulary (pending, running, succeeded, failed, cancelled, needs_attention; a status the board does not define is inconclusive), the run's summary, the pull request and branches, the gates as `checks` (a gate that is not known to have passed is never a pass), what a person must answer or connect, and the failure kind and cause. A field the board has no record of is absent. A read that cannot be confirmed is an inconclusive call, never a failed task. For detail use investigate_job.",
    scope: 'factory:read',
    routes: [['GET', '/api/jobs/:id/thread']],
    annotations: READ_ONLY,
    input: TaskIdInput,
    output: z.object({
        taskId: z.string(),
        runId: z.string(),
        status: z.string(),
        state: RunStateSchema,
        outcome: z.enum(['final', 'in_progress', 'needs_attention', 'inconclusive']),
        summary: z.string().optional(),
        pullRequest: PullRequestView.optional(),
        checks: z
            .object({
                verdict: CheckVerdict,
                gates: z.array(z.object({ name: z.string(), status: z.string(), exitCode: z.number().nullable() })),
            })
            .optional(),
        attention: z
            .object({ openQuestions: z.number(), integrationRequirements: z.array(RequirementView) })
            .optional(),
        error: z
            .object({ kind: z.string().nullable(), cause: z.string().nullable(), exitCode: z.number().nullable() })
            .optional(),
        updatedAt: z.string().describe('The newest time the board recorded on the head run, questions included.'),
    }),
    async run({ taskId }, ctx) {
        const judged = judge(await ctx.fetch({ method: 'GET', url: `${jobPath(taskId)}/thread` }), Thread);
        if (!judged.ok) return judged.tagged;
        const head = headOf(judged.data.jobs);
        const state = stateOf(head);
        const integrationRequirements = requirementsOf(head);
        const openQuestions = (head.questions ?? []).filter((q) => q.status === 'pending' && q.answerable).length;
        const outcome = (
            {
                pending: 'in_progress',
                running: 'in_progress',
                succeeded: 'final',
                failed: 'final',
                cancelled: 'final',
                needs_attention: 'needs_attention',
                unreachable: 'inconclusive',
                inconclusive: 'inconclusive',
            } as const
        )[state];
        const summary = cut(head.summary, MAX_TEXT_CHARS).text;
        const pullRequest = pullRequestOf(head);
        const gates = (head.gates ?? []).map(({ name, status, exitCode }) => ({
            name,
            status,
            exitCode: exitCode ?? null,
        }));
        const failed = known(head.status) && (head.status === 'failed' || head.status === 'dead');
        const data = {
            taskId: head.rootJobId,
            runId: head.id,
            status: head.status,
            state,
            outcome,
            ...(summary === null ? {} : { summary }),
            ...(pullRequest === null ? {} : { pullRequest }),
            ...(gates.length === 0 ? {} : { checks: { verdict: verdictOf(gates), gates } }),
            ...(state === 'needs_attention' ? { attention: { openQuestions, integrationRequirements } } : {}),
            ...(failed ? { error: { kind: head.failureKind, cause: head.failureCause, exitCode: head.exitCode } } : {}),
            updatedAt: latestOf(head),
        };
        return { outcome: 'ok', result: success(data, `${data.taskId}: ${state} (${head.status})`) };
    },
});
