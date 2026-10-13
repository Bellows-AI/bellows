import type { Page, Route } from '@playwright/test';
import type { BatchRecord, BatchSummary } from '../../web/src/batch-model.js';

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
    /** The state-changing requests the page made, as `<method> <path after /api/batches>`. */
    readonly requests: string[] = [];

    constructor(private readonly page: Page) {}

    async install(): Promise<void> {
        await this.page.route(/\/api\/batches(\/|\?|$)/, (route) => this.handle(route));
    }

    adopt(record: BatchRecord): void {
        this.records.set(record.id, record);
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
