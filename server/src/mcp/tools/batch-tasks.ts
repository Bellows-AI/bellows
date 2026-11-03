import { ERROR_CODES } from '@factory-ai/core';
import { z } from 'zod';
import { inconclusive, judge, refusal, success, type Tagged } from '../result.js';
import { defineTool, READ_ONLY } from '../tool.js';
import { BatchIdInput, BatchViewSchema, ReportTaskSchema, StandingSchema, batchPath, reportCovers } from './batches.js';
import { MAX_NAME_CHARS, PAGING_INPUT, DEFAULT_PAGE } from './paging.js';

/**
 * A paged projection over what `GET /api/batches/:id` already carries: the record, the plan, the stage verification and
 * the report read in the same snapshot. It reads, joins and slices; the verdict stays the board's `standing`.
 */

const PlanSchema = z.object({
    defaultTarget: z.string().nullish(),
    targets: z.array(z.object({ key: z.string(), repo: z.string(), branch: z.string().nullish() }).loose()),
    stages: z.array(
        z.object({
            key: z.string(),
            tasks: z.array(z.object({ key: z.string(), target: z.string().nullish() }).loose()),
        })
    ),
});

const ObservationSchema = z.object({ stale: z.boolean(), headSha: z.string().nullish() }).loose();

const TaskRowSchema = z
    .object({
        key: z.string(),
        stage: z.string(),
        execution: z.string(),
        gate: z.string(),
        pr: z.string(),
        waitReason: z.string().nullable(),
        attention: z.string().nullable(),
        rootJobId: z.string().nullable(),
        attempt: z.number().int(),
    })
    .loose();

const VerificationSchema = z.object({
    stage: z.string(),
    state: z.string(),
    detail: z.string().nullable(),
    headSha: z.string().nullable(),
});

const ViewSchema = BatchViewSchema.extend({
    plan: PlanSchema,
    tasks: z.array(TaskRowSchema),
    verification: z.array(VerificationSchema.loose()),
    report: z
        .object({
            id: z.string(),
            tasks: z.array(
                ReportTaskSchema.extend({ pr: z.string().nullable(), observation: ObservationSchema.nullable() })
            ),
        })
        .loose()
        .nullable(),
});

const TaskItemSchema = z.object({
    key: z.string().describe("The task's plan key."),
    stage: z.string(),
    target: z.string().nullable().describe("The plan target's key; null when the plan names none."),
    repo: z.string().nullable(),
    branch: z.string().nullable().describe('The resolved branch; null until the board resolves the plan (a draft).'),
    ref: z.string().nullable().describe('Canonical repo@branch, only when both are known.'),
    execution: z.string(),
    gate: z.string(),
    attention: z.string().nullable(),
    waitReason: z.string().nullable(),
    pr: z.string().nullable(),
    taskId: z.string().nullable().describe("The task's logical id (its thread root); null until launched."),
    attempts: z.number().int(),
    next: z
        .object({ action: z.string() })
        .loose()
        .nullable()
        .describe("The board's next supported step; null for a draft."),
    sourceSha: z.string().nullable().describe('The PR head the board last observed; never inferred.'),
    observation: ObservationSchema.nullable(),
    verification: z.array(VerificationSchema).describe("The task's stage verification rows, all of them."),
});

type TaskItem = z.infer<typeof TaskItemSchema>;

const STATUS_DRAFT = 'draft';
const TASK_NO_PR = 'none';

interface Cursor {
    readonly v: number;
    readonly s: string;
    readonly k: string;
}

const encodeCursor = (cursor: Cursor): string => Buffer.from(JSON.stringify(cursor)).toString('base64url');

const decodeCursor = (raw: string): Cursor | null => {
    try {
        const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
        const shape = z.object({ v: z.number().int(), s: z.string(), k: z.string() }).safeParse(parsed);
        return shape.success ? shape.data : null;
    } catch {
        return null;
    }
};

const refused = (code: string, message: string): Tagged => ({ outcome: 'refused', result: refusal(code, message) });

type View = z.output<typeof ViewSchema>;

/** The verification rows of one stage: all of them, so a second target's unit is not hidden behind the first. */
const verificationOf = (view: View, stage: string) =>
    view.verification
        .filter((row) => row.stage === stage)
        .map(({ state, detail, headSha }) => ({ stage, state, detail, headSha }));

type Planned = View['plan']['stages'][number]['tasks'][number];
type Row = View['tasks'][number];
type Reported = NonNullable<View['report']>['tasks'][number];

/** One task as the caller sees it: the plan's place for it, the record's row, the report's entry. */
function itemOf(
    view: View,
    place: { stage: string; planned: Planned },
    joined: { row: Row; report: Reported | undefined }
): TaskItem {
    const { stage, planned } = place;
    const { row, report } = joined;
    const key = planned.target ?? view.plan.defaultTarget ?? null;
    const one = view.plan.targets.find((candidate) => candidate.key === key);
    const repo = one?.repo ?? null;
    const branch = one?.branch ?? null;
    return {
        key: planned.key,
        stage,
        target: key,
        repo,
        branch,
        ref: repo !== null && branch !== null ? `${repo}@${branch}` : null,
        execution: row.execution,
        gate: row.gate,
        attention: row.attention,
        waitReason: row.waitReason,
        pr: row.pr === TASK_NO_PR ? null : row.pr,
        taskId: row.rootJobId,
        attempts: row.attempt,
        next: report?.next ?? null,
        sourceSha: report?.observation?.headSha ?? null,
        observation: report?.observation ?? null,
        verification: verificationOf(view, stage),
    };
}

/** Why the report cannot be the basis of a list: a started batch without one, or one that misses a task. */
const unreadReport = (view: View): string | null => {
    if (view.status !== STATUS_DRAFT && view.report === null)
        return 'the board could not read the report of this batch';
    if (view.report !== null && !reportCovers(view.report, view))
        return 'the report does not cover every task of the batch';
    return null;
};

/** Every task of the plan in plan order, joined with its row and its report entry; or why they cannot be joined honestly. */
function itemsOf(view: View): { list: TaskItem[] } | { reason: string } {
    const reason = unreadReport(view);
    if (reason !== null) return { reason };
    const reported = new Map((view.report?.tasks ?? []).map((entry) => [entry.key, entry]));
    const rows = new Map(view.tasks.map((row) => [row.key, row]));
    const list: TaskItem[] = [];
    for (const stage of view.plan.stages) {
        for (const planned of stage.tasks) {
            const row = rows.get(planned.key);
            if (!row) return { reason: 'the plan and the task list disagree' };
            list.push(itemOf(view, { stage: stage.key, planned }, { row, report: reported.get(planned.key) }));
        }
    }
    return { list };
}

/** The index in plan order the page starts after (-1 for the first page), or the refusal a cursor earns. */
function positionAfter(cursor: string | undefined, list: readonly TaskItem[], version: number): number | Tagged {
    if (cursor === undefined) return -1;
    const at = decodeCursor(cursor);
    if (at === null) return refused(ERROR_CODES.BAD_CURSOR, 'the cursor is not one this tool issued');
    const index = list.findIndex((item) => item.stage === at.s && item.key === at.k);
    if (at.v !== version || index < 0) {
        return refused('stale_cursor', 'the batch changed since the cursor was issued; read from the first page');
    }
    return index;
}

export const getBatchTasks = defineTool({
    name: 'get_batch_tasks',
    description: `List the tasks of one batch, a page at a time in plan order (stage, then task), each with its plan key, stage, target and canonical repo@branch, state, PR, logical task id, next step, the PR head SHA the board last observed and the verification rows of its stage. Filter with stage, state (the task's execution state) and target (the plan target's key). Pass the returned cursor to read the next page; a cursor from another version of a draft is refused (stale_cursor). The board's \`standing\` rides along and is never computed here. A report that does not cover every task, or that could not be read, is inconclusive: no tasks are listed. \`stale\` is true when a PR observation is marked stale by the board or the standing is inconclusive; those values are the board's last reading. A draft is listed from its plan. Reading never changes the batch; inspect_batch is the whole-batch summary and batch_report the full report.`,
    scope: 'factory:read',
    routes: [['GET', '/api/batches/:id']],
    annotations: READ_ONLY,
    input: BatchIdInput.extend({
        stage: z.string().max(MAX_NAME_CHARS).optional().describe('Only the tasks of this stage key.'),
        state: z
            .string()
            .max(MAX_NAME_CHARS)
            .optional()
            .describe('Only the tasks in this execution state, e.g. failed.'),
        target: z.string().max(MAX_NAME_CHARS).optional().describe("Only the tasks of this plan target's key."),
        ...PAGING_INPUT,
    }),
    output: z.object({
        batchId: z.string(),
        version: z.number().int(),
        status: z.string(),
        standing: StandingSchema,
        tasks: z.array(TaskItemSchema),
        total: z.number().int().describe('Tasks matching the filters, across all pages.'),
        cursor: z.string().nullable().describe('Pass as cursor for the next page; null at the end.'),
        stale: z.boolean(),
    }),
    async run({ batchId, stage, state, target, limit = DEFAULT_PAGE, cursor }, ctx) {
        const read = judge(await ctx.fetch({ method: 'GET', url: batchPath(batchId) }), ViewSchema);
        if (!read.ok) return read.tagged;
        const view = read.data;
        const items = itemsOf(view);
        if ('reason' in items) return { outcome: 'inconclusive', result: inconclusive(items.reason) };
        const after = positionAfter(cursor, items.list, view.version);
        if (typeof after !== 'number') return after;
        const matching = items.list
            .map((item, index) => ({ item, index }))
            .filter(({ item }) => stage === undefined || item.stage === stage)
            .filter(({ item }) => state === undefined || item.execution === state)
            .filter(({ item }) => target === undefined || item.target === target);
        const rest = matching.filter(({ index }) => index > after);
        const page = rest.slice(0, limit);
        const last = page.at(-1);
        const stale =
            view.standing.verdict === 'inconclusive' || items.list.some((item) => item.observation?.stale === true);
        return {
            outcome: 'ok',
            result: success(
                {
                    batchId,
                    version: view.version,
                    status: view.status,
                    standing: view.standing,
                    tasks: page.map(({ item }) => item),
                    total: matching.length,
                    cursor:
                        last && rest.length > page.length
                            ? encodeCursor({ v: view.version, s: last.item.stage, k: last.item.key })
                            : null,
                    stale,
                },
                `${page.length} of ${matching.length} tasks of batch ${batchId}: standing ${view.standing.verdict}${stale ? ' (stale)' : ''}`
            ),
        };
    },
});
