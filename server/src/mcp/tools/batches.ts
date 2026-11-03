import { BATCH_PLAN_JSON_SCHEMA, type BatchVerdict } from '@factory-ai/core';
import { z } from 'zod';
import { inconclusive, judge, success, type Tagged } from '../result.js';
import { defineTool, READ_ONLY, WRITES } from '../tool.js';
import { MAX_NAME_CHARS } from './paging.js';
import { idempotencyKey, keyNote } from './task-writes.js';

/** Plan and batch tools: each is one board batch route as the caller, board refusals verbatim (docs/batches.md). */

const BatchIdInput = z.object({
    batchId: z.string().min(1).max(MAX_NAME_CHARS).describe('A batch id (list_batches).'),
});
const batchPath = (batchId: string): string => `/api/batches/${encodeURIComponent(batchId)}`;

/** The plan, advertised with the board's own schema (core); the board's parser stays the authority and answers every issue by path. */
const PlanInput = z.record(z.string(), z.unknown()).meta(BATCH_PLAN_JSON_SCHEMA);

const PLAN_NOTE =
    'A stored plan is not yet launchable: validate_batch runs the launch checks (visibility, branches, executors, what the executors can run) and start_batch repeats them.';

const VERDICTS = {
    draft: true,
    running: true,
    succeeded: true,
    failed: true,
    cancelled: true,
    needs_attention: true,
    inconclusive: true,
} satisfies Record<BatchVerdict, true>;

/** The board's verdict on the batch (core `batchStanding`): this tool layer reads it and never computes one. */
const StandingSchema = z.object({
    verdict: z.enum(Object.keys(VERDICTS) as [BatchVerdict, ...BatchVerdict[]]),
    fence: z.enum(['cancelled', 'expired']).nullable(),
    attention: z.array(
        z.object({ key: z.string(), stage: z.string(), waitReason: z.string(), pr: z.string().nullable() })
    ),
    verificationFailures: z.array(
        z.object({
            stage: z.string(),
            state: z.string(),
            detail: z.string().nullable(),
            headSha: z.string().nullable(),
        })
    ),
});

const BatchTaskSchema = z.object({ key: z.string(), stage: z.string(), execution: z.string() }).loose();

/** A batch as the board reads it: the record, its `standing`, and the report read in the same snapshot (null when unreadable). */
const BatchViewSchema = z
    .object({
        id: z.string(),
        status: z.string(),
        version: z.number().int(),
        standing: StandingSchema,
        tasks: z.array(BatchTaskSchema),
    })
    .loose();

const DraftSchema = z.object({ id: z.string(), status: z.string(), version: z.number().int() });

const ValidSchema = z.object({ valid: z.boolean(), version: z.number().int(), plan: z.object({}).loose() });

const ListSchema = z.object({
    batches: z.array(
        z
            .object({
                id: z.string(),
                title: z.string(),
                status: z.string(),
                version: z.number().int(),
                taskCount: z.number().int(),
            })
            .loose()
    ),
});

const ReportTaskSchema = z
    .object({
        key: z.string(),
        stage: z.string(),
        next: z.object({ action: z.string() }).loose(),
        observation: z.object({ stale: z.boolean() }).loose().nullable(),
    })
    .loose();
const ReportSchema = z.object({ id: z.string(), state: z.string(), tasks: z.array(ReportTaskSchema) }).loose();

const draftSummary = (verb: string) => (data: z.infer<typeof DraftSchema>) =>
    `${verb} batch ${data.id} (${data.status}, version ${data.version})`;

const viewSummary = (verb: string) => (data: z.infer<typeof BatchViewSchema>) =>
    `${verb} batch ${data.id}: ${data.status}, standing ${data.standing.verdict}`;

const withKey = (key: string | undefined) => (key === undefined ? {} : { idempotencyKey: key });

export const importBatch = defineTool({
    name: 'import_batch',
    description: `Store a batch plan as a new draft, as you; it starts nothing. The plan input is the board's plan schema; a refused plan answers BAD_BATCH with every problem by path. ${PLAN_NOTE} ${keyNote('draft')} Returns the draft id and version.`,
    scope: 'factory:write',
    routes: [['POST', '/api/batches']],
    annotations: WRITES,
    input: z.object({ plan: PlanInput, idempotencyKey }),
    output: DraftSchema,
    run: ({ plan, idempotencyKey: key }, ctx) =>
        ctx.call(
            { method: 'POST', url: '/api/batches', body: { plan }, ...withKey(key) },
            DraftSchema,
            draftSummary('stored')
        ),
});

export const updateBatch = defineTool({
    name: 'update_batch',
    description: `Replace the whole plan of a draft batch. \`version\` is the version you last read; a stale version is refused (BATCH_STALE, with the current version) and nothing is written, and a started batch is frozen (BATCH_STARTED). ${PLAN_NOTE} Returns the new version.`,
    scope: 'factory:write',
    routes: [['PUT', '/api/batches/:id']],
    annotations: WRITES,
    input: BatchIdInput.extend({
        version: z.number().int().min(1).describe("The draft's version as last read."),
        plan: PlanInput,
    }),
    output: DraftSchema,
    run: ({ batchId, version, plan }, ctx) =>
        ctx.call(
            { method: 'PUT', url: batchPath(batchId), body: { version, plan } },
            DraftSchema,
            draftSummary('updated')
        ),
});

export const validateBatch = defineTool({
    name: 'validate_batch',
    description:
        'Run the launch checks on a draft batch without starting it or writing anything: target visibility, branch resolution, what the executors can run, executors. Returns the resolved plan, or the board refusal verbatim: for a plan this board cannot run, code BATCH_UNSUPPORTED with a `reason` of multi_target (more than one repository) or automerge (an automerge stage and no merger).',
    scope: 'factory:read',
    routes: [['POST', '/api/batches/:id/validate']],
    annotations: READ_ONLY,
    input: BatchIdInput,
    output: ValidSchema,
    run: ({ batchId }, ctx) =>
        ctx.call(
            { method: 'POST', url: `${batchPath(batchId)}/validate` },
            ValidSchema,
            (data) => `valid at version ${data.version}`
        ),
});

export const startBatch = defineTool({
    name: 'start_batch',
    description: `Freeze a draft at \`version\` and start it: the board runs the launch checks, then schedules one stage at a time. A plan the board cannot run is refused verbatim (BATCH_UNSUPPORTED, reason multi_target or automerge) and the batch stays a draft; it never degrades to one repository. ${keyNote('batch')} Returns the batch with the board's standing.`,
    scope: 'factory:write',
    routes: [['POST', '/api/batches/:id/start']],
    annotations: WRITES,
    input: BatchIdInput.extend({
        version: z.number().int().min(1).describe("The draft's version as last read."),
        idempotencyKey,
    }),
    output: BatchViewSchema,
    run: ({ batchId, version, idempotencyKey: key }, ctx) =>
        ctx.call(
            { method: 'POST', url: `${batchPath(batchId)}/start`, body: { version }, ...withKey(key) },
            BatchViewSchema,
            viewSummary('started')
        ),
});

export const inspectBatch = defineTool({
    name: 'inspect_batch',
    description:
        "Read one batch: its record and plan, every task's state, the board's `standing` (verdict, fence, attention, verification failures) and the report read in the same snapshot. A verdict of `inconclusive` means the board could not read the whole report: no verdict is claimed. Reading never changes the batch.",
    scope: 'factory:read',
    routes: [['GET', '/api/batches/:id']],
    annotations: READ_ONLY,
    input: BatchIdInput,
    output: BatchViewSchema,
    run: ({ batchId }, ctx) =>
        ctx.call({ method: 'GET', url: batchPath(batchId) }, BatchViewSchema, viewSummary('read')),
});

export const listBatches = defineTool({
    name: 'list_batches',
    description:
        "List the organization's batches, newest first as the board returns them: id, title, status, version, task count.",
    scope: 'factory:read',
    routes: [['GET', '/api/batches']],
    annotations: READ_ONLY,
    input: z.object({}),
    output: ListSchema,
    run: (_args, ctx) =>
        ctx.call({ method: 'GET', url: '/api/batches' }, ListSchema, (data) => `${data.batches.length} batches`),
});

const refusedFirst = (...tagged: Tagged[]): Tagged => tagged.find((one) => one.outcome === 'refused') ?? tagged[0]!;

export const batchReport = defineTool({
    name: 'batch_report',
    description:
        "The batch's morning report: what merged, what is open, what recovery spent, each task's next supported step, beside the board's `standing`. The report is checked against the batch's own task list: a report that does not cover every task is inconclusive, never a verdict. `stale` is true when a PR observation is marked stale by the board or the standing is inconclusive; those values are the board's last reading, not a fresh one. A draft has no report (BATCH_NOT_STARTED).",
    scope: 'factory:read',
    routes: [
        ['GET', '/api/batches/:id/report'],
        ['GET', '/api/batches/:id'],
    ],
    annotations: READ_ONLY,
    input: BatchIdInput,
    output: z.object({ report: ReportSchema, standing: StandingSchema, stale: z.boolean() }),
    async run({ batchId }, ctx) {
        const [reported, read] = await Promise.all([
            ctx.fetch({ method: 'GET', url: `${batchPath(batchId)}/report` }),
            ctx.fetch({ method: 'GET', url: batchPath(batchId) }),
        ]);
        const report = judge(reported, ReportSchema);
        const batch = judge(read, BatchViewSchema);
        if (!report.ok || !batch.ok) {
            return refusedFirst(...[report, batch].flatMap((one) => (one.ok ? [] : [one.tagged])));
        }
        const covered = new Set(report.data.tasks.map((task) => task.key));
        const complete =
            report.data.id === batch.data.id &&
            covered.size === report.data.tasks.length &&
            batch.data.tasks.length === covered.size &&
            batch.data.tasks.every((task) => covered.has(task.key));
        if (!complete) {
            return {
                outcome: 'inconclusive',
                result: inconclusive('the report does not cover every task of the batch'),
            };
        }
        const stale =
            batch.data.standing.verdict === 'inconclusive' ||
            report.data.tasks.some((task) => task.observation?.stale === true);
        return {
            outcome: 'ok',
            result: success(
                { report: report.data, standing: batch.data.standing, stale },
                `report for batch ${batchId}: standing ${batch.data.standing.verdict}${stale ? ' (stale)' : ''}`
            ),
        };
    },
});

export const BATCH_TOOLS = [
    importBatch,
    updateBatch,
    validateBatch,
    startBatch,
    inspectBatch,
    listBatches,
    batchReport,
];
