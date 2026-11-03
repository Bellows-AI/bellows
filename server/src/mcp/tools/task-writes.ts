import { z } from 'zod';
import { judge, refusal, type Tagged } from '../result.js';
import { defineTool, DESTRUCTIVE, WRITES } from '../tool.js';
import { MAX_CONNECTIONS, MAX_NAME_CHARS, MAX_SELECTED } from './paging.js';
import { BoardRunSchema } from './run-state.js';
import { JobIdInput, jobPath } from './runs.js';

/** The board's key bound (`Idempotency-Key must be 8 to 128 characters`); the board checks the rest of the format. */
const MAX_KEY_CHARS = 128;

const KEY_NOTE =
    'Pass idempotencyKey (8 to 128 characters of letters, digits, ".", "_", ":" or "-") and, if the answer is lost or the call times out, retry with the SAME key: a repeat of the same request returns the task the first attempt made instead of a second one, and a different request under the same key is refused.';

const idempotencyKey = z
    .string()
    .min(1)
    .max(MAX_KEY_CHARS)
    .optional()
    .describe('Names this logical attempt. Reuse the same key when retrying after a lost answer.');

// The command is the exact text: newlines and Unicode kept, the empty and over-long bounds are the board's.
const command = (what: string) =>
    z.string().describe(`${what} Sent exactly as given; the board refuses empty or over-long text.`);

const attachmentIds = z
    .array(z.string().max(MAX_NAME_CHARS))
    .max(MAX_SELECTED)
    .optional()
    .describe(
        'Ids of completed, already-uploaded files you own to bind to the task. A client-local path is not readable by the board. Every id must be valid or the whole request is refused.'
    );

const QueuedSchema = z.object({ id: z.string(), status: z.string() });

/** The body of a write: only the fields the caller gave, so an absent one is the board's default, not a null. */
const bodyOf = (fields: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

const queuedSummary = (verb: string) => (data: z.infer<typeof QueuedSchema>) => `${verb} ${data.id} (${data.status})`;

export const createTask = defineTool({
    name: 'create_task',
    description: `Queue a new task (a run of an agent) on the board, as you. ${KEY_NOTE} Check the selection first with preflight_task; the board rechecks at create and at claim. A missing or lapsed integration is surfaced on the task as an integration requirement (see get_task_result), never completed here. Returns the task id.`,
    scope: 'factory:write',
    routes: [['POST', '/api/jobs']],
    annotations: WRITES,
    input: z.object({
        command: command('What the agent should do.'),
        repo: z
            .string()
            .min(1)
            .max(MAX_NAME_CHARS)
            .describe('owner/name of the repository (list_repos); the board requires it.'),
        baseBranch: z.string().max(MAX_NAME_CHARS).optional().describe("Default: the repository's default branch."),
        executor: z.string().max(MAX_NAME_CHARS).optional().describe('An executor profile name (list_executors).'),
        executorScope: z.enum(['user', 'org']).optional().describe('Which profile list `executor` names.'),
        skills: z
            .array(z.string().max(MAX_NAME_CHARS))
            .max(MAX_SELECTED)
            .optional()
            .describe('Skill names (list_skills).'),
        connections: z
            .array(z.string().max(MAX_NAME_CHARS))
            .max(MAX_CONNECTIONS)
            .optional()
            .describe('Ids of your own connections (list_connections); omit to use your defaults.'),
        attachmentIds,
        idempotencyKey,
    }),
    output: QueuedSchema,
    run: ({ attachmentIds: attachments, idempotencyKey: key, ...fields }, ctx) =>
        ctx.call(
            {
                method: 'POST',
                url: '/api/jobs',
                body: bodyOf({ ...fields, attachments }),
                ...(key === undefined ? {} : { idempotencyKey: key }),
            },
            QueuedSchema,
            queuedSummary('queued')
        ),
});

export const followUpTask = defineTool({
    name: 'follow_up_task',
    description: `Queue a follow-up run on a finished task's thread, in its session and checkout. ${KEY_NOTE} Returns the new run id.`,
    scope: 'factory:write',
    routes: [['POST', '/api/jobs/:id/follow-up']],
    annotations: WRITES,
    input: JobIdInput.extend({ command: command('What the agent should do next.'), attachmentIds, idempotencyKey }),
    output: QueuedSchema,
    run: ({ jobId, command: text, attachmentIds: attachments, idempotencyKey: key }, ctx) =>
        ctx.call(
            {
                method: 'POST',
                url: `${jobPath(jobId)}/follow-up`,
                body: bodyOf({ command: text, attachments }),
                ...(key === undefined ? {} : { idempotencyKey: key }),
            },
            QueuedSchema,
            queuedSummary('queued follow-up')
        ),
});

export const retryTask = defineTool({
    name: 'retry_task',
    description: `Queue a retry of a failed run; its already-authorized bindings carry over. ${KEY_NOTE} Returns the new run id.`,
    scope: 'factory:write',
    routes: [['POST', '/api/jobs/:id/retry']],
    annotations: WRITES,
    input: JobIdInput.extend({ idempotencyKey }),
    output: QueuedSchema,
    run: ({ jobId, idempotencyKey: key }, ctx) =>
        ctx.call(
            {
                method: 'POST',
                url: `${jobPath(jobId)}/retry`,
                ...(key === undefined ? {} : { idempotencyKey: key }),
            },
            QueuedSchema,
            queuedSummary('queued retry')
        ),
});

const EditedSchema = z.object({ id: z.string(), status: z.string(), command: z.string() });

export const editTask = defineTool({
    name: 'edit_task',
    description:
        'Replace the command of a task that is still queued (not yet claimed), when you queued it. The board refuses an edit once a worker has claimed it, on a task you did not queue, and on a workflow task. The same task keeps its id.',
    scope: 'factory:write',
    routes: [['PATCH', '/api/jobs/:id']],
    annotations: WRITES,
    input: JobIdInput.extend({ command: command('The new command.') }),
    output: EditedSchema,
    run: ({ jobId, command: text }, ctx) =>
        ctx.call(
            { method: 'PATCH', url: jobPath(jobId), body: { command: text } },
            EditedSchema,
            (data) => `edited ${data.id}`
        ),
});

const ThreadSchema = z.object({ jobs: z.array(BoardRunSchema) });
const AnsweredSchema = z.object({
    id: z.string(),
    status: z.string(),
    answers: z.record(z.string(), z.string()).nullable(),
});

const refused = (code: string, message: string): Tagged => ({ outcome: 'refused', result: refusal(code, message) });

export const answerQuestion = defineTool({
    name: 'answer_question',
    description:
        'Answer a question an agent asked (see list_questions). `answers` holds one answer per prompt, in the order list_questions shows the prompts; give the option label, or free text. The board refuses an answer that arrives after the question was answered, expired or closed. Needs read access as well, to look up the prompts. Never use this to complete an integration connect.',
    scope: 'factory:write',
    routes: [
        ['GET', '/api/jobs/:id/thread'],
        ['POST', '/api/jobs/:id/questions/:questionId/answer'],
    ],
    annotations: WRITES,
    input: JobIdInput.extend({
        questionId: z.string().min(1).max(MAX_NAME_CHARS).describe('The question id from list_questions.'),
        answers: z.array(z.string()).min(1).max(MAX_SELECTED).describe('One answer per prompt, in prompt order.'),
    }),
    output: AnsweredSchema,
    async run({ jobId, questionId, answers }, ctx) {
        const thread = judge(await ctx.fetch({ method: 'GET', url: `${jobPath(jobId)}/thread` }), ThreadSchema);
        if (!thread.ok) return thread.tagged;
        for (const run of thread.data.jobs) {
            const asked = (run.questions ?? []).find((entry) => entry.id === questionId);
            if (!asked) continue;
            if (asked.questions.length !== answers.length) {
                return refused(
                    'answers_mismatch',
                    `question ${questionId} has ${asked.questions.length} prompt(s); give one answer for each, in order (got ${answers.length})`
                );
            }
            const prompts = asked.questions.map((prompt) => prompt.question);
            if (new Set(prompts).size !== prompts.length) {
                return refused(
                    'duplicate_prompts',
                    `question ${questionId} repeats a prompt text, so answers cannot be told apart by prompt; refusing to send fewer answers than prompts`
                );
            }
            return ctx.call(
                {
                    method: 'POST',
                    url: `${jobPath(run.id)}/questions/${encodeURIComponent(questionId)}/answer`,
                    body: {
                        answers: Object.fromEntries(prompts.map((prompt, i) => [prompt, answers[i]])),
                    },
                },
                AnsweredSchema,
                (data) => `answered ${data.id}`
            );
        }
        return refused('question_not_found', `no question ${questionId} on the task of ${jobId}`);
    },
});

const StoppedSchema = z.object({
    id: z.string(),
    status: z.string(),
    cancelRequestedAt: z.string().nullable().optional(),
});

export const stopTask = defineTool({
    name: 'stop_task',
    description:
        'Stop a queued or running task. A queued run is stopped at once; a running one is asked to stop and settles at its next heartbeat (`cancelRequestedAt` is set). Destructive: requires confirm: true.',
    scope: 'factory:write',
    routes: [['POST', '/api/jobs/:id/stop']],
    annotations: DESTRUCTIVE,
    confirm: true,
    input: JobIdInput,
    output: StoppedSchema,
    run: ({ jobId }, ctx) =>
        ctx.call(
            { method: 'POST', url: `${jobPath(jobId)}/stop` },
            StoppedSchema,
            (data) => `stop ${data.id}: ${data.status}`
        ),
});

const DoneSchema = z.object({
    id: z.string(),
    status: z.string().optional(),
    doneAt: z.string().nullable(),
    batch: z.string().optional(),
    task: z.string().optional(),
    outcome: z.enum(['cancelled', 'kept']).optional(),
    pr: z.string().nullable().optional(),
});
const doneSummary = (data: z.infer<typeof DoneSchema>) =>
    `${data.id} ${data.doneAt ? `marked done at ${data.doneAt}` : 'closing'}`;

export const markTaskDone = defineTool({
    name: 'mark_task_done',
    description:
        "Mark a finished task done: your verdict that it needs nothing more (the run's own outcome is unchanged). The board refuses a task that is still running, and a task that backs a live batch (the batch closes it when it ends; force_close_task is the explicit override).",
    scope: 'factory:write',
    routes: [['POST', '/api/jobs/:id/done']],
    annotations: WRITES,
    input: JobIdInput,
    output: DoneSchema,
    run: ({ jobId }, ctx) => ctx.call({ method: 'POST', url: `${jobPath(jobId)}/done` }, DoneSchema, doneSummary),
});

export const forceCloseTask = defineTool({
    name: 'force_close_task',
    description:
        'Force a task closed, including one that backs a live batch: stops its run, cancels its batch task (never retried; a required task holds its stage until the batch is cancelled) and leaves the pull request it opened open, naming it in the answer. A closing run may answer with doneAt null while it settles. Destructive: requires confirm: true.',
    scope: 'factory:write',
    routes: [['POST', '/api/jobs/:id/done']],
    annotations: DESTRUCTIVE,
    confirm: true,
    input: JobIdInput,
    output: DoneSchema,
    run: ({ jobId }, ctx) =>
        ctx.call({ method: 'POST', url: `${jobPath(jobId)}/done`, body: { force: true } }, DoneSchema, doneSummary),
});

const ReopenedSchema = z.object({ id: z.string(), reopened: z.boolean() });

export const reopenTask = defineTool({
    name: 'reopen_task',
    description:
        'Clear the done mark of a task so it takes a follow-up again. Safe to repeat. The board refuses a task that is not done, one whose worktree was already reclaimed, and a batch task.',
    scope: 'factory:write',
    routes: [['POST', '/api/jobs/:id/reopen']],
    annotations: { ...WRITES, idempotentHint: true },
    input: JobIdInput,
    output: ReopenedSchema,
    run: ({ jobId }, ctx) =>
        ctx.call({ method: 'POST', url: `${jobPath(jobId)}/reopen` }, ReopenedSchema, (data) => `reopened ${data.id}`),
});

const RemovedSchema = z.object({ id: z.string(), removed: z.boolean() });

export const removeTask = defineTool({
    name: 'remove_task',
    description:
        'Delete a task and its whole thread, and queue its worktree for reclaim. Cannot be undone. The board refuses a task that is still running (stop it first) and a batch task. Destructive: requires confirm: true.',
    scope: 'factory:write',
    routes: [['POST', '/api/jobs/:id/remove']],
    annotations: DESTRUCTIVE,
    confirm: true,
    input: JobIdInput,
    output: RemovedSchema,
    run: ({ jobId }, ctx) =>
        ctx.call({ method: 'POST', url: `${jobPath(jobId)}/remove` }, RemovedSchema, (data) => `removed ${data.id}`),
});

export const TASK_WRITE_TOOLS = [
    createTask,
    followUpTask,
    retryTask,
    editTask,
    answerQuestion,
    stopTask,
    markTaskDone,
    forceCloseTask,
    reopenTask,
    removeTask,
];
