import { z } from 'zod';
import { judge, success } from '../result.js';
import { defineTool, READ_ONLY } from '../tool.js';
import { BoardRunSchema, RunViewSchema, runView, type BoardRun } from './run-state.js';

const MAX_ID_CHARS = 64;
export const JobIdInput = z.object({
    jobId: z.string().min(1).max(MAX_ID_CHARS).describe('A run id, or the id of its task (the root run).'),
});
export const jobPath = (jobId: string): string => `/api/jobs/${encodeURIComponent(jobId)}`;

const ThreadSchema = z.object({ jobs: z.array(BoardRunSchema) });

export const investigateJob = defineTool({
    name: 'investigate_job',
    description:
        'Read one run and the whole thread it belongs to (oldest run first): status, the shared `state` (an open question is needs_attention, and so is an integration requirement the head run waits on), failure kind and cause, gates, pull request, and the run output cut to a bound. Both reads must succeed; one that cannot be confirmed makes the call inconclusive rather than a partial answer.',
    scope: 'factory:read',
    routes: [
        ['GET', '/api/jobs/:id'],
        ['GET', '/api/jobs/:id/thread'],
    ],
    annotations: READ_ONLY,
    input: JobIdInput,
    output: z.object({ job: RunViewSchema, thread: z.array(RunViewSchema) }),
    async run({ jobId }, ctx) {
        const [one, thread] = await Promise.all([
            ctx.fetch({ method: 'GET', url: jobPath(jobId) }),
            ctx.fetch({ method: 'GET', url: `${jobPath(jobId)}/thread` }),
        ]);
        const job = judge(one, BoardRunSchema);
        if (!job.ok) return job.tagged;
        const jobs = judge(thread, ThreadSchema);
        if (!jobs.ok) return jobs.tagged;
        // The board attaches the root's open requirements to every run of the thread; only the head run is waiting on them.
        const head = jobs.data.jobs.at(-1);
        const own = (run: BoardRun): BoardRun => (run.id === head?.id ? run : { ...run, integrationRequirements: [] });
        const view = runView(own(job.data), true);
        return {
            outcome: 'ok',
            result: success(
                { job: view, thread: jobs.data.jobs.map((run) => runView(own(run), true)) },
                `${view.id}: ${view.state}`
            ),
        };
    },
});

export const listQuestions = defineTool({
    name: 'list_questions',
    description:
        "List the questions the thread's agents asked, oldest first: question id, each prompt with its options, status, and whether an answer would land now (`answerable`). The order and ids are what answer_question expects.",
    scope: 'factory:read',
    routes: [['GET', '/api/jobs/:id/thread']],
    annotations: READ_ONLY,
    input: JobIdInput,
    output: z.object({
        questions: z.array(
            z.object({
                jobId: z.string(),
                id: z.string(),
                attempt: z.number(),
                status: z.enum(['pending', 'answered', 'expired', 'closed']),
                answerable: z.boolean(),
                prompts: z.array(
                    z.object({
                        question: z.string(),
                        header: z.string(),
                        multiSelect: z.boolean(),
                        options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
                    })
                ),
                answers: z.record(z.string(), z.string()).nullable(),
                answeredBy: z.string().nullable(),
                askedAt: z.string(),
                answeredAt: z.string().nullable(),
            })
        ),
    }),
    async run({ jobId }, ctx) {
        const thread = judge(await ctx.fetch({ method: 'GET', url: `${jobPath(jobId)}/thread` }), ThreadSchema);
        if (!thread.ok) return thread.tagged;
        const questions = thread.data.jobs.flatMap((run) =>
            (run.questions ?? []).map((q) => ({
                jobId: run.id,
                id: q.id,
                attempt: q.attempt,
                status: q.status,
                answerable: q.answerable,
                prompts: q.questions,
                answers: q.answers ?? null,
                answeredBy: q.answeredBy?.login ?? null,
                askedAt: q.askedAt,
                answeredAt: q.answeredAt,
            }))
        );
        return { outcome: 'ok', result: success({ questions }, `${questions.length} questions`) };
    },
});

export const jobActivity = defineTool({
    name: 'job_activity',
    description:
        "Read a run's activity: token usage over time, and the gates and pull requests the board recorded for the run and for its whole task. Figures the board did not measure read as `unmeasured` or `unavailable` in `usage.state`, never as zero; a null field is not recorded.",
    scope: 'factory:read',
    routes: [['GET', '/api/jobs/:id/activity']],
    annotations: READ_ONLY,
    input: JobIdInput,
    output: z.object({
        jobId: z.string(),
        sessionId: z.string().nullable(),
        from: z.string().nullable(),
        to: z.string().nullable(),
        bucketMs: z.number().nullable(),
        buckets: z.array(z.unknown()),
        usage: z.unknown(),
        task: z.unknown(),
        gates: z.unknown(),
        prs: z.unknown(),
        taskActivity: z.unknown(),
    }),
    run: ({ jobId }, ctx) =>
        ctx.call(
            { method: 'GET', url: `${jobPath(jobId)}/activity` },
            z.object({
                jobId: z.string(),
                sessionId: z.string().nullable(),
                from: z.string().nullable(),
                to: z.string().nullable(),
                bucketMs: z.number().nullable(),
                buckets: z.array(z.unknown()),
                usage: z.object({ state: z.string() }).loose(),
                task: z.unknown(),
                gates: z.unknown(),
                prs: z.unknown(),
                taskActivity: z.unknown(),
            }),
            (data) => `activity of ${data.jobId}: usage ${data.usage.state}`
        ),
});
