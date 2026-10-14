import type { Page, Route } from '@playwright/test';
import {
    type BatchRecord,
    type BatchReportView,
    type BatchSummary,
    type BatchTaskState,
    blankPlan,
    updateTask,
} from '../../web/src/batch-model.js';

/**
 * A stand-in for the board's scheduler on the open e2e board, where no driver runs a task: it
 * answers the batch routes from held records, and the start the page presses mutates the held
 * record the way the board's own store does. It judges nothing the page does not ask for — the
 * browser under test is the only thing being verified.
 *
 * A route this does not hold falls through to the real board, so a draft is created and saved
 * against the real API and only adopted here once it exists.
 */

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;

const summaryOf = (record: BatchRecord): BatchSummary => ({
    id: record.id,
    title: record.plan.title,
    status: record.status,
    version: record.version,
    taskCount: record.tasks.length,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    startedAt: record.startedAt,
    cancelledAt: record.cancelledAt,
    completedAt: record.completedAt,
    expiredAt: record.expiredAt,
});

export class BatchBoard {
    private readonly records = new Map<string, BatchRecord>();
    /** Each batch's report as the board would assemble it; a batch adopted without one names no task's next step. */
    private readonly reports = new Map<string, BatchReportView>();
    /** The state-changing requests the page made, as `<method> <path after /api/batches>`. */
    readonly requests: string[] = [];

    constructor(private readonly page: Page) {}

    async install(): Promise<void> {
        await this.page.route(/\/api\/batches(\/|\?|$)/, (route) => this.handle(route));
    }

    adopt(record: BatchRecord, report?: BatchReportView): void {
        this.records.set(record.id, record);
        if (report) this.reports.set(record.id, report);
    }

    private held(id: string): BatchRecord {
        const record = this.records.get(id);
        if (!record) throw new Error(`the fake board holds no batch ${id}`);
        return record;
    }

    private mutate(id: string, change: (record: BatchRecord) => BatchRecord): BatchRecord {
        const next = change(this.held(id));
        this.records.set(id, next);
        return next;
    }

    private async handle(route: Route): Promise<void> {
        const request = route.request();
        const url = new URL(request.url());
        // `/api/batches/<id>/<action>`
        const [, , id, ...rest] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        const method = request.method();
        if (id === undefined) {
            if (method !== 'GET') return route.fallback();
            const task = url.searchParams.get('task');
            const all = [...this.records.values()].filter(
                (record) => task === null || record.tasks.some((candidate) => candidate.rootJobId === task)
            );
            return route.fulfill({ status: HTTP_OK, json: { batches: all.map(summaryOf) } });
        }
        if (!this.records.has(id)) return route.fallback();
        if (method !== 'GET') this.requests.push(`${method} /${[id, ...rest].join('/')}`);
        return route.fulfill({ status: HTTP_OK, json: this.answer(id, method, rest, request.postDataJSON()) });
    }

    private answer(id: string, method: string, rest: string[], body: { version?: number; plan?: BatchRecord['plan'] }) {
        const now = new Date().toISOString();
        const [action] = rest;
        if (method === 'GET' && action === 'report') {
            return this.reports.get(id) ?? { state: this.held(id).status, tasks: [] };
        }
        if (method === 'GET') return this.held(id);
        if (method === 'PUT') {
            const next = this.mutate(id, (record) => ({
                ...record,
                version: record.version + 1,
                plan: body.plan ?? record.plan,
                updatedAt: now,
            }));
            return { id, status: next.status, version: next.version };
        }
        if (action === 'validate') return { valid: true, version: this.held(id).version, plan: this.held(id).plan };
        if (action === 'start') {
            return this.mutate(id, (record) => ({
                ...record,
                status: 'running',
                startedAt: now,
                activeStage: record.plan.stages[0]?.key ?? null,
                tasks: record.tasks.map((task) => ({ ...task, execution: 'pending' })),
            }));
        }
        throw new Error(`the fake board has no answer for ${method} ${rest.join('/')} (${HTTP_NOT_FOUND})`);
    }
}

/** A one-task batch running its first stage, `task-1` finished with a pull request. */
function runningBatch(
    id: string,
    over: { plan: Partial<BatchRecord['plan']>; task?: Partial<BatchTaskState> },
    verification: BatchRecord['verification'] = []
): BatchRecord {
    const plan = updateTask({ ...blankPlan('acme/widgets'), ...over.plan }, 'task-1', (task) => ({
        ...task,
        objective: 'Bump it',
        acceptance: 'Builds',
        verification: 'npm test',
    }));
    const now = new Date().toISOString();
    return {
        id,
        status: 'running',
        version: 3,
        createdBy: null,
        startedBy: null,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        cancelledAt: null,
        completedAt: null,
        expiredAt: null,
        activeStage: 'stage-1',
        plan,
        tasks: [
            {
                key: 'task-1',
                stage: 'stage-1',
                execution: 'succeeded',
                pr: 'https://github.com/acme/widgets/pull/9',
                gate: 'passed',
                waitReason: null,
                rootJobId: null,
                attempt: 1,
                ...over.task,
            },
        ],
        verification,
    };
}

/** The batch-detail states the nightly gallery shoots: each a record, and the report the board would assemble. */
export const BATCH_DETAIL_STATES: Record<string, { record: BatchRecord; report?: BatchReportView }> = {
    'verification-failed': {
        record: runningBatch('0f53d75f-0000-4000-8000-000000000654', { plan: { title: 'Held stage' } }, [
            {
                stage: 'stage-1',
                state: 'failed',
                detail: 'checks on main at cd89f3d2 fail: e2e failing',
                headSha: 'cd89f3d2aabbccdd',
                checkedAt: new Date().toISOString(),
            },
        ]),
    },
    'board-merging': {
        record: runningBatch('0f53d75f-0000-4000-8000-000000000693', {
            plan: { title: 'Board merging', policy: 'automerge' },
            task: { gate: 'open', waitReason: 'waiting for the board to merge https://github.com/acme/widgets/pull/9' },
        }),
        report: {
            state: 'running',
            tasks: [{ key: 'task-1', execution: 'succeeded', attempts: 1, next: { action: 'wait' } }],
        },
    },
};
