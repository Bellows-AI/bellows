import { z } from 'zod';
import { judge, success } from '../result.js';
import { defineTool, READ_ONLY } from '../tool.js';
import { MAX_CURSOR_CHARS, MAX_NAME_CHARS, queryOf } from './paging.js';
import {
    BoardRunSchema,
    BoardStatusSchema,
    cut,
    MAX_TEXT_CHARS,
    RunStateSchema,
    RunViewSchema,
    runView,
    stateOfTask,
} from './run-state.js';

/** `GET /api/tasks` bounds, mirrored from `routes/tasks.ts`. */
const TASK_PAGE_MAX = 50;
/** `GET /api/jobs` ceiling, mirrored from `routes/jobs/job-limits.ts`. */
const JOB_PAGE_MAX = 200;
const STATUS_MAX_CHARS = 32;

const nullableText = z
    .string()
    .nullish()
    .transform((v) => v ?? null);

const BoardTask = z.object({
    id: z.string(),
    headRunId: z.string(),
    command: z.string(),
    status: BoardStatusSchema,
    doneAt: nullableText,
    repo: nullableText,
    executor: nullableText,
    author: z.object({ login: z.string() }).nullish(),
    summary: nullableText,
    waitReason: nullableText,
    needsAnswer: z.boolean(),
    createdAt: z.string(),
    activityAt: z.string(),
});
const BoardTasks = z.object({
    navigation: z.object({ counts: z.object({ running: z.number(), review: z.number(), past: z.number() }) }),
    page: z.object({ items: z.array(BoardTask), nextCursor: z.string().nullable() }),
});

export const listTasks = defineTool({
    name: 'list_tasks',
    description:
        "List tasks (one per conversation) as the board's inbox shows them. `state` filters the inbox: attention (default), running, review or past. Each row carries the head run's status and a `state` in the shared vocabulary (pending, running, succeeded, failed, cancelled, needs_attention); a task with an open question is needs_attention. Pass `nextCursor` back as `cursor` with the same filters until it is null.",
    scope: 'factory:read',
    routes: [['GET', '/api/tasks']],
    annotations: READ_ONLY,
    input: z.object({
        state: z
            .enum(['attention', 'running', 'review', 'past'])
            .optional()
            .describe('Inbox section (default attention).'),
        q: z.string().max(MAX_NAME_CHARS).optional().describe('Search text.'),
        author: z.string().max(MAX_NAME_CHARS).optional().describe("The task author's login."),
        repo: z.string().max(MAX_NAME_CHARS).optional().describe('owner/name.'),
        sort: z.enum(['newest', 'oldest']).optional(),
        limit: z.number().int().min(1).max(TASK_PAGE_MAX).optional().describe(`Page size, 1-${TASK_PAGE_MAX}.`),
        cursor: z
            .string()
            .max(MAX_CURSOR_CHARS)
            .optional()
            .describe('The nextCursor of the previous page, same filters.'),
    }),
    output: z.object({
        tasks: z.array(
            z.object({
                id: z.string(),
                headRunId: z.string(),
                command: z.string(),
                status: BoardStatusSchema,
                state: RunStateSchema,
                done: z.boolean(),
                repo: z.string().nullable(),
                executor: z.string().nullable(),
                author: z.string().nullable(),
                summary: z.string().nullable(),
                waitReason: z.string().nullable(),
                needsAnswer: z.boolean(),
                createdAt: z.string(),
                activityAt: z.string(),
            })
        ),
        nextCursor: z.string().nullable(),
        counts: z.object({ running: z.number(), review: z.number(), past: z.number() }),
    }),
    async run(args, ctx) {
        const judged = judge(await ctx.fetch({ method: 'GET', url: `/api/tasks${queryOf(args)}` }), BoardTasks);
        if (!judged.ok) return judged.tagged;
        const { page, navigation } = judged.data;
        const tasks = page.items.map((t) => ({
            id: t.id,
            headRunId: t.headRunId,
            command: cut(t.command, MAX_TEXT_CHARS).text ?? '',
            status: t.status,
            state: stateOfTask(t.status, t.needsAnswer),
            done: t.doneAt !== null,
            repo: t.repo,
            executor: t.executor,
            author: t.author?.login ?? null,
            summary: cut(t.summary, MAX_TEXT_CHARS).text,
            waitReason: t.waitReason,
            needsAnswer: t.needsAnswer,
            createdAt: t.createdAt,
            activityAt: t.activityAt,
        }));
        return {
            outcome: 'ok',
            result: success(
                { tasks, nextCursor: page.nextCursor, counts: navigation.counts },
                `${tasks.length} tasks${page.nextCursor ? ', more available' : ''}`
            ),
        };
    },
});

export const listJobs = defineTool({
    name: 'list_jobs',
    description:
        "List runs (a task is a thread of runs), newest first, bounded by `limit`. `status` is a board status (queued, running, succeeded, failed, dead, stopped) or 'terminal' for every settled one. A row's `state` comes from the run's status alone: an open question or integration requirement shows only in investigate_job and list_questions. For paging through tasks use list_tasks.",
    scope: 'factory:read',
    routes: [['GET', '/api/jobs']],
    annotations: READ_ONLY,
    input: z.object({
        status: z.string().max(STATUS_MAX_CHARS).optional().describe("A board status, or 'terminal'."),
        repo: z.string().max(MAX_NAME_CHARS).optional().describe('owner/name.'),
        limit: z.number().int().min(1).max(JOB_PAGE_MAX).optional().describe(`1-${JOB_PAGE_MAX}.`),
    }),
    output: z.object({ jobs: z.array(RunViewSchema) }),
    async run(args, ctx) {
        const judged = judge(
            await ctx.fetch({ method: 'GET', url: `/api/jobs${queryOf(args)}` }),
            z.object({ jobs: z.array(BoardRunSchema) })
        );
        if (!judged.ok) return judged.tagged;
        const jobs = judged.data.jobs.map((run) => runView(run, false));
        return { outcome: 'ok', result: success({ jobs }, `${jobs.length} runs`) };
    },
});
